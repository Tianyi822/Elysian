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

async function reloadResources(gateway: ElysianGateway, range: TimeRange): Promise<void> {
  try {
    const resources = await gateway.resources.list(range)
    useDashboardStore.setState({ resources, errorMessage: undefined })
  } catch (error) {
    useDashboardStore.setState({
      errorMessage:
        error instanceof Error ? error.message : '切换时间范围后读取资源数据失败',
    })
  }
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
  async load(gateway) {
    attachLiveEvents()
    boundGateway = gateway
    const range = get().range
    set({ status: 'loading', errorMessage: undefined })
    try {
      const data = await loadDashboard(gateway, range)
      set({ status: 'ready', ...data })
    } catch (error) {
      set({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '读取仪表盘数据失败',
      })
    }
  },
  async refresh(gateway) {
    boundGateway = gateway
    const range = get().range
    set({ refreshing: true, errorMessage: undefined })
    try {
      const data = await loadDashboard(gateway, range)
      set({ status: 'ready', ...data, refreshing: false })
    } catch (error) {
      set({
        refreshing: false,
        errorMessage: error instanceof Error ? error.message : '刷新仪表盘数据失败',
      })
    }
  },
  setRange(range) {
    set({ range })
    const gateway = boundGateway
    if (gateway) void reloadResources(gateway, range)
  },
}))
