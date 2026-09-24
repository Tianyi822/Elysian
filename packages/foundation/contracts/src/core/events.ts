import type { Container, ContainerStatus } from '../container/containers.ts'
import type { AgentStatus, ApprovalOutcome, Severity } from './enums.ts'

/** 事件分发模式，与 Cordis 的 @mode 约定一致。 */
export type EventMode = 'emit' | 'waterfall' | 'serial' | 'parallel'

/**
 * 类型化事件表。Cordis 里各域用
 * `declare module '@elysian/contracts' { interface Events { ... } }`
 * 往这张表里加自己的事件；本包先声明本期需要的全部事件，后续域按同样方式追加。
 * 每个事件的 JSDoc 标注分发模式：
 *
 * - `emit` 只广播事实，不等应答；
 * - `waterfall` 需要应答，回调带 `next()`；
 * - `serial` 顺序等待，`parallel` 并发等待。
 *
 * 事件流只承载 `emit` 型事件；其余三种需要双向通道，本期不实现。
 */
export interface Events {
  /** @mode emit */
  'agent/created': { runId: string; moduleId: string; incidentId?: string }
  /** @mode emit */
  'agent/status': { moduleId: string; status: AgentStatus }
  /** @mode waterfall */
  'agent/pre-step': { runId: string; stepIndex: number }
  /** @mode serial */
  'agent/turn-stopping': { runId: string; turnIndex: number }
  /** @mode waterfall */
  'tools/pre-execute': { runId: string; toolName: string }
  /** @mode waterfall */
  'tools/execute': { runId: string; toolName: string }
  /** @mode waterfall */
  'tools/post-execute': { runId: string; toolName: string; ok: boolean }
  /** @mode waterfall */
  'approval/request': { approvalId: string; actionId: string }
  /** @mode emit */
  'approval/asked': { approvalId: string }
  /** @mode emit */
  'approval/decided': { approvalId: string; outcome: ApprovalOutcome }
  /** @mode emit */
  'skills/change': { skillId: string; enabled: boolean }
  /** @mode emit */
  'session/event': { summary: string }
  /** @mode emit */
  'incident/created': { incidentId: string; severity: Severity; moduleId?: string }
  /** @mode emit */
  'incident/updated': { incidentId: string; status?: string }
  /** @mode emit */
  'resource/sample': {
    cpu: number
    memory: number
    networkIo: number
    networkRx: number
    networkTx: number
    diskIo: number
    diskRead: number
    diskWrite: number
    /** Linux load average 风格的运行负载（1/5/15 分钟均值）。 */
    load: { m1: number; m5: number; m15: number }
    /** 磁盘占用：按挂载点的使用率与容量（KiB，与 df -k 一致）。 */
    disks: ReadonlyArray<{ mount: string; usagePct: number; usedKb: number; sizeKb: number }>
  }
  /** @mode emit */
  'container/sample': {
    /** 全部运行中容器的资源采样；停止/重启中的容器不在载荷里。 */
    samples: ReadonlyArray<{ containerId: string; cpuPercent: number; memMb: number }>
  }
  /** @mode emit */
  'container/updated': { containerId: string; status: ContainerStatus; startedAt: string | null }
  /** @mode emit */
  'container/removed': { containerId: string }
  /** @mode emit */
  'container/resync': Record<string, never>
  /** @mode emit */
  'container/created': { container: Container }
}

export type EventName = keyof Events & string

/** 运行期的事件名清单。类型层由 `Events` 保证完备，这里供流实现与测试遍历。 */
export const EVENT_NAMES = [
  'agent/created',
  'agent/status',
  'agent/pre-step',
  'agent/turn-stopping',
  'tools/pre-execute',
  'tools/execute',
  'tools/post-execute',
  'approval/request',
  'approval/asked',
  'approval/decided',
  'skills/change',
  'session/event',
  'incident/created',
  'incident/updated',
  'resource/sample',
  'container/sample',
  'container/updated',
  'container/removed',
  'container/resync',
  'container/created',
] as const satisfies readonly EventName[]

/** 每个事件的分发模式。`Record<EventName, EventMode>` 由类型系统保证不漏不重。 */
export const EVENT_MODES: Record<EventName, EventMode> = {
  'agent/created': 'emit',
  'agent/status': 'emit',
  'agent/pre-step': 'waterfall',
  'agent/turn-stopping': 'serial',
  'tools/pre-execute': 'waterfall',
  'tools/execute': 'waterfall',
  'tools/post-execute': 'waterfall',
  'approval/request': 'waterfall',
  'approval/asked': 'emit',
  'approval/decided': 'emit',
  'skills/change': 'emit',
  'session/event': 'emit',
  'incident/created': 'emit',
  'incident/updated': 'emit',
  'resource/sample': 'emit',
  'container/sample': 'emit',
  'container/updated': 'emit',
  'container/removed': 'emit',
  'container/resync': 'emit',
  'container/created': 'emit',
}

/**
 * 事件信封：事件流的一帧与未来真实网关共用同一形状。
 * 按 `name` 收窄后 `payload` 的类型随之确定。
 */
export type ElysianEvent = {
  [K in EventName]: {
    /** 单调递增的事件标识，用于断线续传。 */
    id: string
    name: K
    at: string
    payload: Events[K]
  }
}[EventName]

/** 事件流的连接状态。 */
export type EventStreamStatus = 'connecting' | 'live' | 'degraded'

/** 事件流订阅回调。 */
export type EventStreamHandlers = {
  onEvent: (event: ElysianEvent) => void
  onStatus: (status: EventStreamStatus) => void
}

/** 退订函数。订阅接口返回它，transport 因此可替换。 */
export type Unsubscribe = () => void
