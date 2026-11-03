import { captureAuthGeneration } from '../adapters/http/unauthorized'
import type { Unsubscribe } from '@elysian/contracts'
import { create } from 'zustand'
import {
  DEFAULT_TIME_RANGE,
  timeRangeDurationMs,
} from '../adapters/mock/resourceMetrics'
import type { ResourceSamplePoint, TimeRange } from '../adapters/mock/resourceMetrics'
import type { ElysianGateway } from '../contracts/adapters'
import { onStreamEvent } from './eventStreamStore'

/** 同一 SSE 节拍内重复到达时合并为一点，避免图表重复柱。 */
const SAMPLE_MERGE_DEDUPE_MS = 4500

/** 将最新采样并入当前时间窗序列（设计：SSE 最新点并入当前窗，不重拉 mock 全量）。 */
export function mergeResourceSampleIntoWindow(
  resources: readonly ResourceSamplePoint[] | undefined,
  range: TimeRange,
  point: ResourceSamplePoint,
): ResourceSamplePoint[] {
  const cutoff = point.ts - timeRangeDurationMs(range)
  const inWindow = (resources ?? []).filter((p) => p.ts >= cutoff && p.ts <= point.ts)
  const last = inWindow.at(-1)
  if (last && point.ts - last.ts < SAMPLE_MERGE_DEDUPE_MS) {
    return [...inWindow.slice(0, -1), point]
  }
  return [...inWindow, point]
}

export type DashboardState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  refreshing: boolean
  /** 当前时间窗内的资源采样序列（毫秒时间戳横轴）。 */
  resources?: readonly ResourceSamplePoint[]
  range: TimeRange
  errorMessage?: string
  load: (gateway: ElysianGateway) => Promise<void>
  refresh: (gateway: ElysianGateway) => Promise<void>
  setRange: (range: TimeRange) => void
}

export async function loadDashboard(gateway: ElysianGateway, range: TimeRange) {
  const resources = await gateway.resources.list(range)
  return { resources }
}

/*
 * 事件回灌：事件流是仪表盘的心跳。resource/sample 将最新点并入当前窗序列。
 */
let detachLive: Unsubscribe | undefined
let boundGateway: ElysianGateway | undefined
let readSequence = 0
let pendingRead: { gateway: ElysianGateway; range: TimeRange; auth: number; promise: Promise<void> } | undefined

function reloadResources(gateway: ElysianGateway, range: TimeRange, manual = false): Promise<void> {
  const auth = captureAuthGeneration()
  if (pendingRead?.gateway === gateway && pendingRead.range === range && pendingRead.auth === auth) {
    if (manual) useDashboardStore.setState({ refreshing: true })
    return pendingRead.promise
  }
  const sequence = ++readSequence
  const hadData = useDashboardStore.getState().resources !== undefined
  const operation = { gateway, range, auth, promise: Promise.resolve() }
  pendingRead = operation
  const current = () => sequence === readSequence && auth === captureAuthGeneration() && useDashboardStore.getState().range === range
  useDashboardStore.setState({ status: hadData ? 'ready' : 'loading', refreshing: manual, errorMessage: undefined })
  operation.promise = (async () => {
    try {
      const { resources } = await loadDashboard(gateway, range)
      if (current()) useDashboardStore.setState({ status: 'ready', resources, errorMessage: undefined })
    } catch (error) {
      if (current()) useDashboardStore.setState({ status: hadData ? 'ready' : 'error', errorMessage: error instanceof Error ? error.message : '读取仪表盘数据失败' })
    } finally {
      if (pendingRead === operation) {
        pendingRead = undefined
        if (auth === captureAuthGeneration()) useDashboardStore.setState({ refreshing: false })
      }
    }
  })()
  return operation.promise
}

function attachLiveEvents(): void {
  if (detachLive) return
  detachLive = onStreamEvent((event) => {
    const { status } = useDashboardStore.getState()
    if (status !== 'ready') return

    if (event.name === 'resource/sample') {
      const ts = Date.parse(event.at)
      const atMs = Number.isFinite(ts) ? ts : Date.now()
      const { cpu, memory, networkIo, networkRx, networkTx, diskIo, diskRead, diskWrite } =
        event.payload
      const point: ResourceSamplePoint = {
        ts: atMs,
        cpu,
        memory,
        networkIo,
        networkRx,
        networkTx,
        diskIo,
        diskRead,
        diskWrite,
      }
      useDashboardStore.setState((state) => ({
        resources: mergeResourceSampleIntoWindow(state.resources, state.range, point),
      }))
    }
  })
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  status: 'idle',
  refreshing: false,
  range: DEFAULT_TIME_RANGE,
  load(gateway) {
    attachLiveEvents()
    boundGateway = gateway
    return reloadResources(gateway, get().range)
  },
  refresh(gateway) {
    boundGateway = gateway
    return reloadResources(gateway, get().range, true)
  },
  setRange(range) {
    set({ range })
    const gateway = boundGateway
    if (gateway) void reloadResources(gateway, range)
  },
}))
