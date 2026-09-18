import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EventName } from '@elysian/contracts'
import { createMockDataset } from '../mock/dataset.ts'
import {
  INITIAL_DISKS,
  INITIAL_LOAD,
  listMockHistory,
  nextDisksWalk,
  nextLoadWalk,
  seedMockHistoryIfEmpty,
  TIME_RANGES,
  type ResourceSamplePoint,
  type TimeRange,
} from '../mock/resourceMetrics.ts'
import type { DiskUsage, SystemLoad } from '../mock/resourceMetrics.ts'
import type { HostSamplePrev } from '../hostMetrics/readHostSample.ts'
import { SSE_HEARTBEAT, formatSseFrame } from './parse.ts'

/**
 * dev 与 preview 共用的 mock 事件流端点：GET /api/events。
 *
 * 它按真实 SSE 写线上格式（命名事件、单调递增 id、retry、注释帧心跳），
 * 事件内容取自与界面同一份确定性数据集，因此演示时事件引用的标识与页面里看到的一致。
 * 生产路径同形，未来换成真实网关即可，客户端不需要改。
 */

/** 资源采样与 SSE retry 节拍（与仪表盘约定一致）。 */
export const TICK_MS = 3000
const HEARTBEAT_MS = 15_000
/** 连上后先补发一拍，避免初始数据连续跳变。 */
const REPLAY_BURST = 1

export type PlannedEvent = {
  name: EventName
  payload: unknown
}

/** 事件序列：运行状态、审批请求、事故变更，按数据集顺序轮转。 */
export function buildEventPlan(): PlannedEvent[] {
  const dataset = createMockDataset()
  const plan: PlannedEvent[] = []

  for (const run of dataset.runs) {
    plan.push({
      name: 'agent/status',
      payload: { moduleId: run.moduleId, status: run.status === 'running' ? 'running' : 'idle' },
    })
  }
  for (const approval of dataset.approvals) {
    plan.push({ name: 'approval/asked', payload: { approvalId: approval.id } })
  }
  for (const incident of dataset.incidents) {
    plan.push({
      name: 'incident/updated',
      payload: { incidentId: incident.id, status: incident.status },
    })
  }

  return plan
}

export function eventIdAt(sequence: number): string {
  return `evt-${sequence}`
}

export type ResourceSample = {
  cpu: number
  memory: number
  networkIo: number
  diskIo: number
  load: SystemLoad
  disks: DiskUsage[]
}

const WALK_BOUNDS = {
  cpu: [20, 90, 2],
  memory: [45, 92, 1],
  networkIo: [60, 950, 40],
  diskIo: [40, 520, 30],
} as const

const LIVE_SEVERITY_ROLL: ReadonlyArray<readonly [string, number]> = [
  ['sev1', 0.1],
  ['sev2', 0.3],
  ['sev3', 0.7],
  ['sev4', 1.0],
]

/** 资源采样随机游走：每拍在既有值附近小幅移动，保持在上限区间内。 */
export function nextResourceSample(walk: ResourceSample): ResourceSample {
  const step = (value: number, key: keyof typeof WALK_BOUNDS): number => {
    const [min, max, delta] = WALK_BOUNDS[key]
    const next = value + Math.round((Math.random() - 0.5) * 2 * delta)
    return Math.min(max as number, Math.max(min as number, next))
  }
  return {
    cpu: step(walk.cpu, 'cpu'),
    memory: step(walk.memory, 'memory'),
    networkIo: step(walk.networkIo, 'networkIo'),
    diskIo: step(walk.diskIo, 'diskIo'),
    load: nextLoadWalk(walk.load),
    disks: nextDisksWalk(walk.disks),
  }
}

/** 初始游走状态：负载取低位空闲值，磁盘占用取种子配置。 */
export function initialResourceWalk(): ResourceSample {
  return {
    cpu: 55,
    memory: 68,
    networkIo: 380,
    diskIo: 210,
    load: { ...INITIAL_LOAD },
    disks: INITIAL_DISKS.map((disk) => ({ ...disk })),
  }
}

/** 每 8 拍产生一次新事故；返回 undefined 表示这一拍不产生。 */
export function maybeIncidentCreated(
  tick: number,
  liveIncidentIndex: number,
): PlannedEvent | undefined {
  if (tick % 8 !== 0) return undefined
  const roll = Math.random()
  const severity = LIVE_SEVERITY_ROLL.find(([, ceiling]) => roll < ceiling)?.[0] ?? 'sev4'
  return {
    name: 'incident/created',
    payload: { incidentId: `INC-LIVE-${liveIncidentIndex + 1}`, severity },
  }
}

/**
 * 从 Last-Event-ID 解析出续传起点。无法识别时从 0 开始，
 * 续传因此不会重发已经投递过的 id。
 */
export function sequenceFromLastEventId(lastEventId: string | null | undefined): number {
  if (!lastEventId) return 0
  const match = /^evt-(\d+)$/.exec(lastEventId)
  const digits = match?.[1]
  if (!digits) return 0
  const parsed = Number.parseInt(digits, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function readLastEventId(req: IncomingMessage): string | undefined {
  const header = req.headers['last-event-id']
  if (Array.isArray(header)) return header[0]
  if (typeof header === 'string') return header
  const url = new URL(req.url ?? '/api/events', 'http://localhost')
  return url.searchParams.get('lastEventId') ?? undefined
}

/**
 * 事件序列号在进程内全局递增，而不是每条连接各自从 1 开始。
 * 否则客户端一旦重新订阅（或开第二个标签页），标识就会从头再来，
 * 界面上就会出现重复事件；与真实事件总线的单调标识也更接近。
 */
let globalSequence = 0

export type HistoryHandlerStore = {
  query(range: TimeRange, nowMs: number): ResourceSamplePoint[]
}

export type MetricsTickStore = HistoryHandlerStore & {
  insertRaw(point: ResourceSamplePoint): void
  rollupMinuteIfNeeded(nowMs: number): void
  prune(nowMs: number): void
}

export type ResourceHistoryHandlerDeps = {
  docker: boolean
  store?: HistoryHandlerStore
  nowMs?: () => number
}

/** 校验 history 查询参数 range，合法则返回 TimeRange。 */
export function parseHistoryRangeParam(raw: string | null | undefined): TimeRange | undefined {
  if (!raw) return undefined
  return (TIME_RANGES as readonly string[]).includes(raw) ? (raw as TimeRange) : undefined
}

export function createResourceHistoryHandler(deps: ResourceHistoryHandlerDeps) {
  const nowMs = deps.nowMs ?? (() => Date.now())

  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }

    const url = new URL(req.url ?? '/api/resources/history', 'http://localhost')
    const range = parseHistoryRangeParam(url.searchParams.get('range'))
    if (!range) {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: '无效的时间范围' }))
      return
    }

    const at = nowMs()
    let points
    if (deps.docker && deps.store) {
      points = deps.store.query(range, at)
    } else {
      seedMockHistoryIfEmpty(at)
      points = listMockHistory(range, at)
    }

    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(points))
  }
}

export type EventsHandlerDeps = {
  docker?: boolean
  /** Docker 下本机采样；返回下一拍所需的 prev。 */
  readSample?: (
    prev?: HostSamplePrev,
  ) => Promise<{ sample: ResourceSample; nextPrev: HostSamplePrev } | null>
  store?: MetricsTickStore
}

export function createEventsHandler(deps: EventsHandlerDeps = {}) {
  const docker = deps.docker === true

  return (req: IncomingMessage, res: ServerResponse): void => {
    // 每个连接独立推进拍数与实时事故序号；资源采样走随机游走或本机采样。
    let tick = 0
    let liveIncidentIndex = 0
    let walk: ResourceSample = initialResourceWalk()
    let hostPrev: HostSamplePrev | undefined
    let sampleInFlight = false

    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const plan = buildEventPlan()
    // 客户端带续传标识时从它的后继继续（真实补发它错过的事件）；
    // 全新连接接在全局序列之后，不重放历史。
    const resumeFrom = sequenceFromLastEventId(readLastEventId(req))
    let sequence = resumeFrom > 0 ? resumeFrom : globalSequence
    let sent = 0

    const emit = (name: EventName, payload: unknown): void => {
      sequence += 1
      globalSequence = sequence
      const event = {
        id: eventIdAt(sequence),
        name,
        at: new Date().toISOString(),
        payload,
      }
      res.write(formatSseFrame({ id: event.id, event: event.name, data: event }))
    }

    const emitPlannedAndLive = (): void => {
      const live = maybeIncidentCreated(tick, liveIncidentIndex)
      if (live) {
        liveIncidentIndex += 1
        emit(live.name, live.payload)
      }

      if (plan.length === 0) return
      const planned = plan[(tick - 1) % plan.length]
      if (!planned) return
      emit(planned.name, planned.payload)
    }

    const persistAndEmitSample = (sample: ResourceSample, tsMs: number): void => {
      const store = deps.store
      if (store) {
        store.insertRaw({
          ts: tsMs,
          cpu: sample.cpu,
          memory: sample.memory,
          networkIo: sample.networkIo,
          diskIo: sample.diskIo,
        })
        store.rollupMinuteIfNeeded(tsMs)
        store.prune(tsMs)
      }
      emit('resource/sample', sample)
      emitPlannedAndLive()
    }

    // 一拍 = 一条资源采样 + 计划内事件；每 8 拍再产生一次新事故。
    const sendNext = () => {
      tick += 1
      sent += 1

      if (docker) {
        if (sampleInFlight || !deps.readSample) return
        sampleInFlight = true
        deps
          .readSample(hostPrev)
          .then((result) => {
            if (!result) return
            hostPrev = result.nextPrev
            persistAndEmitSample(result.sample, Date.now())
          })
          .catch(() => {
            // 该拍跳过：读 /proc 失败时不拖垮 SSE 连接。
          })
          .finally(() => {
            sampleInFlight = false
          })
        return
      }

      walk = nextResourceSample(walk)
      persistAndEmitSample(walk, Date.now())
    }

    res.write(`retry: ${TICK_MS}\n\n`)
    // 连上后先补发几帧，避免界面空等一个 tick 才有内容。
    while (sent < REPLAY_BURST) sendNext()

    const tickTimer = setInterval(sendNext, TICK_MS)
    const heartbeat = setInterval(() => res.write(SSE_HEARTBEAT), HEARTBEAT_MS)

    const cleanup = () => {
      clearInterval(tickTimer)
      clearInterval(heartbeat)
      res.end()
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
  }
}
