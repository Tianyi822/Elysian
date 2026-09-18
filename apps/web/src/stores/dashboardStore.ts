import type { AuditRecord, Unsubscribe } from '@elysian/contracts'
import { create } from 'zustand'
import { aggregateStatCards, buildModuleCards } from '../adapters/mock/aggregations'
import type { ModuleCard, StatCards } from '../adapters/mock/aggregations'
import { BASE_DATE } from '../adapters/mock/dataset'
import { MockResourceHistoryAdapter } from '../adapters/mock/resourceHistoryAdapter'
import {
  DEFAULT_TIME_RANGE,
  INITIAL_DISKS,
  INITIAL_LOAD,
  appendMockSample,
  timeRangeDurationMs,
} from '../adapters/mock/resourceMetrics'
import type {
  DiskUsage,
  ResourceSamplePoint,
  SystemLoad,
  TimeRange,
} from '../adapters/mock/resourceMetrics'
import type { ElysianGateway } from '../contracts/adapters'
import { onStreamEvent } from './eventStreamStore'

/** 同一 SSE 节拍内重复到达时合并为一点，避免图表重复柱。 */
const SAMPLE_MERGE_DEDUPE_MS = 2500

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

export function sameSystemSnapshot(
  a: { load: SystemLoad; disks: readonly DiskUsage[] },
  b: { load: SystemLoad; disks: readonly DiskUsage[] },
): boolean {
  return (
    a.load.m1 === b.load.m1 &&
    a.load.m5 === b.load.m5 &&
    a.load.m15 === b.load.m15 &&
    a.disks.length === b.disks.length &&
    a.disks.every((d, i) => d.mount === b.disks[i]?.mount && d.usagePct === b.disks[i]?.usagePct)
  )
}

export type DashboardState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  refreshing: boolean
  stats?: StatCards
  modules?: ModuleCard[]
  /** 当前时间窗内的资源采样序列（毫秒时间戳横轴）。 */
  resources?: readonly ResourceSamplePoint[]
  /** 系统负载与磁盘占用的最新采样，随事件心跳更新。 */
  system?: { load: SystemLoad; disks: readonly DiskUsage[] }
  auditRecords?: readonly AuditRecord[]
  range: TimeRange
  errorMessage?: string
  load: (gateway: ElysianGateway) => Promise<void>
  refresh: (gateway: ElysianGateway) => Promise<void>
  setRange: (range: TimeRange) => void
}

export async function loadDashboard(gateway: ElysianGateway, range: TimeRange) {
  const [incidentList, runs, moduleStatuses, approvals, audit, skills, resources] =
    await Promise.all([
      gateway.incidents.listRows({}),
      gateway.runs.list(),
      gateway.runs.listModuleStatuses(),
      gateway.approvals.list(),
      gateway.audit.list(),
      gateway.skills.list(),
      gateway.resources.list(range),
    ])

  const input = {
    incidentRows: incidentList.rows,
    runs,
    approvals,
    audit,
    skills,
  }

  return {
    stats: aggregateStatCards(input, BASE_DATE),
    modules: buildModuleCards({ incidentRows: incidentList.rows, runs, approvals, moduleStatuses }),
    resources,
    system: { load: { ...INITIAL_LOAD }, disks: INITIAL_DISKS.map((disk) => ({ ...disk })) },
    auditRecords: audit,
  }
}

/*
 * 事件回灌：事件流是仪表盘的心跳。resource/sample 将最新点并入当前窗序列，
 * incident/created 增量更新指标卡与模块卡（数据集侧由 gateway 落库，刷新后一致）。
 */
let detachLive: Unsubscribe | undefined
/** 已增量应用过的新事故标识：同一事故的重复事件（重连重放）不推高两次。 */
const appliedLiveIncidents = new Set<string>()
let boundGateway: ElysianGateway | undefined
/** 内存 mock 历史缓冲需与 SSE 同步；HTTP/SQLite 路径只合并界面序列。 */
let syncSamplesToMockBuffer = false

async function reloadResources(gateway: ElysianGateway, range: TimeRange): Promise<void> {
  const resources = await gateway.resources.list(range)
  useDashboardStore.setState({ resources })
}

function attachLiveEvents(): void {
  if (detachLive) return
  detachLive = onStreamEvent((event) => {
    const { status } = useDashboardStore.getState()
    if (status !== 'ready') return

    if (event.name === 'incident/created') {
      if (appliedLiveIncidents.has(event.payload.incidentId)) return
      appliedLiveIncidents.add(event.payload.incidentId)
      useDashboardStore.setState((state) => ({
        stats: state.stats && {
          ...state.stats,
          totalIncidents: state.stats.totalIncidents + 1,
          openIncidents: state.stats.openIncidents + 1,
        },
        modules: state.modules?.map((module) =>
          event.payload.moduleId && module.moduleId === event.payload.moduleId
            ? { ...module, activeIncidents: module.activeIncidents + 1 }
            : module,
        ),
      }))
      return
    }

    if (event.name === 'resource/sample') {
      const ts = Date.parse(event.at)
      const atMs = Number.isFinite(ts) ? ts : Date.now()
      const { cpu, memory, networkIo, diskIo, load, disks } = event.payload
      const point: ResourceSamplePoint = { ts: atMs, cpu, memory, networkIo, diskIo }
      if (syncSamplesToMockBuffer) {
        appendMockSample(point, atMs)
      }
      useDashboardStore.setState((state) => {
        const resources = mergeResourceSampleIntoWindow(state.resources, state.range, point)
        const nextSystem = { load, disks }
        return {
          resources,
          system:
            state.system && sameSystemSnapshot(state.system, nextSystem)
              ? state.system
              : nextSystem,
        }
      })
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
    syncSamplesToMockBuffer = gateway.resources instanceof MockResourceHistoryAdapter
    appliedLiveIncidents.clear()
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
    syncSamplesToMockBuffer = gateway.resources instanceof MockResourceHistoryAdapter
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
