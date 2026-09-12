import type { AgentStatus, ApprovalOutcome, Severity } from './enums'

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
  'incident/created': { incidentId: string; severity: Severity }
  /** @mode emit */
  'incident/updated': { incidentId: string; status?: string }
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
