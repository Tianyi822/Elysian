import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EventName } from '@elysian/contracts'
import type { Plugin } from 'vite'
import { createMockDataset } from '../mock/dataset'
import { SSE_HEARTBEAT, formatSseFrame } from './parse'

/**
 * dev 与 preview 共用的 mock 事件流端点：GET /api/events。
 *
 * 它按真实 SSE 写线上格式（命名事件、单调递增 id、retry、注释帧心跳），
 * 事件内容取自与界面同一份确定性数据集，因此演示时事件引用的标识与页面里看到的一致。
 * 生产路径同形，未来换成真实网关即可，客户端不需要改。
 */

const TICK_MS = 2500
const HEARTBEAT_MS = 15_000
/** 连上后先补发的帧数：避免界面空等一个 tick 才有内容。 */
const REPLAY_BURST = 3

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

export function createEventsHandler() {
  return (req: IncomingMessage, res: ServerResponse): void => {
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

    const sendNext = () => {
      if (plan.length === 0) return
      sequence += 1
      globalSequence = sequence
      sent += 1
      const planned = plan[(sequence - 1) % plan.length]
      if (!planned) return
      const event = {
        id: eventIdAt(sequence),
        name: planned.name,
        at: new Date().toISOString(),
        payload: planned.payload,
      }
      res.write(formatSseFrame({ id: event.id, event: event.name, data: event }))
    }

    res.write(`retry: ${TICK_MS}\n\n`)
    // 连上后先补发几帧，避免界面空等一个 tick 才有内容。
    while (sent < REPLAY_BURST) sendNext()

    const tick = setInterval(sendNext, TICK_MS)
    const heartbeat = setInterval(() => res.write(SSE_HEARTBEAT), HEARTBEAT_MS)

    const cleanup = () => {
      clearInterval(tick)
      clearInterval(heartbeat)
      res.end()
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
  }
}

export function mockEventsPlugin(): Plugin {
  const handler = createEventsHandler()
  return {
    name: 'elysian-mock-events',
    configureServer(server) {
      server.middlewares.use('/api/events', handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/events', handler)
    },
  }
}
