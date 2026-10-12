import { create } from 'zustand'
import type {
  AgentApproval,
  AgentApprovalDecision,
  AgentExecutionBarrier,
  AgentOperation,
  AgentReconciliationDecision,
  AgentResourceLease,
} from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'

/*
 * 审批与治理域唯一 store。三个列表（审批/屏障/租约）各自独立六态，互不拖累；
 * 列表为全量数组不分页，runId 深链过滤在前端做，workflowId 过滤经服务端查询参数
 * （租约端点不接受查询参数，只能前端过滤）。写动作全部无 requestId：单飞锁
 * （同目标在途即拒绝发第二次）＋服务端幂等/冲突码；动作成功后静默回读最新事实，
 * 绝不自动重放任何提交。屏障核实联动释放的租约由回读前后快照对比得出，
 * 供页面给出「已释放」提示——不猜测服务端之外的事实。
 */

export type AgentApprovalsListStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 四类可撤销能力（与服务端 capability_routes.go 的 kind 对齐）。 */
export type AgentRevocationKind = 'skill' | 'mcp' | 'execution-profile' | 'grant'

/** 本会话内完成的撤销事实：服务端列表端点不回传撤销状态，界面据此标注「已撤销」。 */
export type AgentRevocationFact = {
  kind: AgentRevocationKind
  id: string
  revision: number
  reason: string
  revokedAt: string
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}

function readErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** 页面判定 429 queue-full 的统一出口（AgentHttpError 与 mock 领域错误同形）。 */
export function isQueueFullError(error: unknown): boolean {
  return readErrorCode(error) === 'queue-full'
}

export type AgentApprovalsState = {
  approvals: readonly AgentApproval[]
  approvalsStatus: AgentApprovalsListStatus
  approvalsError?: string
  approvalsReloading: boolean
  barriers: readonly AgentExecutionBarrier[]
  barriersStatus: AgentApprovalsListStatus
  barriersError?: string
  barriersReloading: boolean
  locks: readonly AgentResourceLease[]
  locksStatus: AgentApprovalsListStatus
  locksError?: string
  locksReloading: boolean
  /** 屏障概要所需的 Run 操作清单（GET /runs/{id}/operations），按 runId 缓存。 */
  operationsByRun: Readonly<Record<string, readonly AgentOperation[]>>
  operationsLoading: Readonly<Record<string, boolean>>
  revocations: readonly AgentRevocationFact[]
  runFilter?: string
  workflowFilter?: string
  decidingIds: readonly string[]
  reconcilingBarrierIds: readonly string[]
  reconcilingLockIds: readonly string[]
  revokingKeys: readonly string[]
  loadApprovals(gateway: ElysianGateway, options?: { silent?: boolean; signal?: AbortSignal }): Promise<void>
  loadBarriers(gateway: ElysianGateway, options?: { silent?: boolean; signal?: AbortSignal }): Promise<void>
  loadLocks(gateway: ElysianGateway, options?: { silent?: boolean; signal?: AbortSignal }): Promise<void>
  loadOperations(gateway: ElysianGateway, runId: string, options?: { signal?: AbortSignal }): Promise<void>
  setFilters(filters: { runId?: string; workflowId?: string }): void
  decideApproval(gateway: ElysianGateway, approvalId: string, decision: AgentApprovalDecision): Promise<AgentApproval | undefined>
  reconcileBarrier(
    gateway: ElysianGateway,
    barrierId: string,
    input: { evidence: string; decision: AgentReconciliationDecision },
  ): Promise<{ barrier: AgentExecutionBarrier; releasedLeaseIds: readonly string[] } | undefined>
  reconcileLock(gateway: ElysianGateway, lockId: string, input: { evidence: string }): Promise<AgentResourceLease | undefined>
  revokeCapability(
    gateway: ElysianGateway,
    kind: AgentRevocationKind,
    id: string,
    revision: number,
    reason: string,
  ): Promise<{ revoked: boolean } | undefined>
  reset(): void
}

const REVOKE_METHODS: Record<AgentRevocationKind, (gateway: ElysianGateway, id: string, revision: number, reason: string) => Promise<{ revoked: boolean }>> = {
  skill: (gateway, id, revision, reason) => gateway.agentApprovals.revokeSkill(id, revision, reason),
  mcp: (gateway, id, revision, reason) => gateway.agentApprovals.revokeMcpServer(id, revision, reason),
  'execution-profile': (gateway, id, revision, reason) => gateway.agentApprovals.revokeExecutionProfile(id, revision, reason),
  grant: (gateway, id, revision, reason) => gateway.agentApprovals.revokeGrant(id, revision, reason),
}

export const useAgentApprovalsStore = create<AgentApprovalsState>((set, get) => {
  const sequences = { approvals: 0, barriers: 0, locks: 0 }

  const listLoader = (
    key: 'approvals' | 'barriers' | 'locks',
    read: (gateway: ElysianGateway, options: { silent?: boolean; signal?: AbortSignal }) => Promise<readonly unknown[]>,
  ) => async (gateway: ElysianGateway, options?: { silent?: boolean; signal?: AbortSignal }) => {
    const sequence = ++sequences[key]
    const silent = options?.silent === true
    const hasContent = get()[key].length > 0
    if (!silent) {
      set(key === 'approvals'
        ? { approvalsStatus: get().approvalsStatus === 'ready' || hasContent ? 'ready' : 'loading', approvalsReloading: true, approvalsError: undefined }
        : key === 'barriers'
          ? { barriersStatus: get().barriersStatus === 'ready' || hasContent ? 'ready' : 'loading', barriersReloading: true, barriersError: undefined }
          : { locksStatus: get().locksStatus === 'ready' || hasContent ? 'ready' : 'loading', locksReloading: true, locksError: undefined })
    }
    try {
      const items = await read(gateway, options ?? {})
      if (sequence !== sequences[key]) return
      if (key === 'approvals') set({ approvals: items as readonly AgentApproval[], approvalsStatus: 'ready', approvalsError: undefined, approvalsReloading: false })
      else if (key === 'barriers') set({ barriers: items as readonly AgentExecutionBarrier[], barriersStatus: 'ready', barriersError: undefined, barriersReloading: false })
      else set({ locks: items as readonly AgentResourceLease[], locksStatus: 'ready', locksError: undefined, locksReloading: false })
    } catch (error) {
      if (sequence !== sequences[key] || isAbort(error)) return
      const message = messageOf(error, '读取审批与治理数据失败')
      const hasContent = get()[key].length > 0
      if (!hasContent) {
        // 首次加载失败才整块落到错误态；已有内容时保留旧内容，绝不白屏。
        set(key === 'approvals'
          ? { approvalsStatus: 'error', approvalsError: message, approvalsReloading: false }
          : key === 'barriers'
            ? { barriersStatus: 'error', barriersError: message, barriersReloading: false }
            : { locksStatus: 'error', locksError: message, locksReloading: false })
        return
      }
      set(key === 'approvals'
        ? { approvalsError: message, approvalsReloading: false }
        : key === 'barriers'
          ? { barriersError: message, barriersReloading: false }
          : { locksError: message, locksReloading: false })
      // 静默轮询失败向上抛出，让 useSilentPolling 计失败并进入退避/降级提示。
      if (silent) throw error
    }
  }

  const loadApprovals = listLoader('approvals', (gateway, options) =>
    gateway.agentApprovals.listApprovals(get().workflowFilter || undefined, options.signal))
  const loadBarriers = listLoader('barriers', (gateway, options) =>
    gateway.agentApprovals.listBarriers(get().workflowFilter || undefined, options.signal))
  const loadLocks = listLoader('locks', (gateway, options) =>
    gateway.agentApprovals.listResourceLocks(options.signal))

  const reloadSilently = async (gateway: ElysianGateway, keys: ReadonlyArray<'approvals' | 'barriers' | 'locks'>) => {
    await Promise.all(keys.map((key) => (key === 'approvals' ? loadApprovals : key === 'barriers' ? loadBarriers : loadLocks)(gateway, { silent: true }).catch(() => undefined)))
  }

  return {
    approvals: [],
    approvalsStatus: 'idle',
    approvalsReloading: false,
    barriers: [],
    barriersStatus: 'idle',
    barriersReloading: false,
    locks: [],
    locksStatus: 'idle',
    locksReloading: false,
    operationsByRun: {},
    operationsLoading: {},
    revocations: [],
    decidingIds: [],
    reconcilingBarrierIds: [],
    reconcilingLockIds: [],
    revokingKeys: [],

    loadApprovals,
    loadBarriers,
    loadLocks,

    async loadOperations(gateway, runId, options) {
      if (get().operationsLoading[runId] === true) return
      set((state) => ({ operationsLoading: { ...state.operationsLoading, [runId]: true } }))
      try {
        const operations = await gateway.agentApprovals.listOperations(runId, options?.signal)
        set((state) => ({ operationsByRun: { ...state.operationsByRun, [runId]: operations }, operationsLoading: { ...state.operationsLoading, [runId]: false } }))
      } catch (error) {
        set((state) => ({ operationsLoading: { ...state.operationsLoading, [runId]: false } }))
        if (!isAbort(error)) throw error
      }
    },

    setFilters(filters) {
      set({ runFilter: filters.runId || undefined, workflowFilter: filters.workflowId || undefined })
    },

    async decideApproval(gateway, approvalId, decision) {
      if (get().decidingIds.includes(approvalId)) return undefined
      set((state) => ({ decidingIds: [...state.decidingIds, approvalId] }))
      try {
        const approval = await gateway.agentApprovals.decideApproval(approvalId, { decision })
        await reloadSilently(gateway, ['approvals'])
        return approval
      } finally {
        set((state) => ({ decidingIds: state.decidingIds.filter((id) => id !== approvalId) }))
      }
    },

    async reconcileBarrier(gateway, barrierId, input) {
      if (get().reconcilingBarrierIds.includes(barrierId)) return undefined
      const locksBefore = get().locks
      set((state) => ({ reconcilingBarrierIds: [...state.reconcilingBarrierIds, barrierId] }))
      try {
        const barrier = await gateway.agentApprovals.reconcileBarrier(barrierId, input)
        await reloadSilently(gateway, ['barriers', 'locks'])
        const locksAfter = get().locks
        const beforeById = new Map(locksBefore.map((lock) => [lock.id, lock]))
        const releasedLeaseIds = barrier.operationId === undefined
          ? []
          : locksAfter
            .filter((lock) => lock.operationId === barrier.operationId && lock.state === 'released' && beforeById.get(lock.id)?.state !== 'released')
            .map((lock) => lock.id)
        return { barrier, releasedLeaseIds }
      } finally {
        set((state) => ({ reconcilingBarrierIds: state.reconcilingBarrierIds.filter((id) => id !== barrierId) }))
      }
    },

    async reconcileLock(gateway, lockId, input) {
      if (get().reconcilingLockIds.includes(lockId)) return undefined
      set((state) => ({ reconcilingLockIds: [...state.reconcilingLockIds, lockId] }))
      try {
        const lease = await gateway.agentApprovals.reconcileResourceLock(lockId, { evidence: input.evidence, decision: 'confirmed-stopped' })
        await reloadSilently(gateway, ['locks'])
        return lease
      } finally {
        set((state) => ({ reconcilingLockIds: state.reconcilingLockIds.filter((id) => id !== lockId) }))
      }
    },

    async revokeCapability(gateway, kind, id, revision, reason) {
      const key = `${kind}:${id}`
      if (get().revokingKeys.includes(key)) return undefined
      set((state) => ({ revokingKeys: [...state.revokingKeys, key] }))
      try {
        const result = await REVOKE_METHODS[kind](gateway, id, revision, reason)
        if (result.revoked) {
          set((state) => {
            const exists = state.revocations.some((fact) => fact.kind === kind && fact.id === id && fact.revision === revision)
            return exists ? state : { revocations: [...state.revocations, { kind, id, revision, reason, revokedAt: new Date().toISOString() }] }
          })
        }
        return result
      } finally {
        set((state) => ({ revokingKeys: state.revokingKeys.filter((item) => item !== key) }))
      }
    },

    reset() {
      sequences.approvals += 1
      sequences.barriers += 1
      sequences.locks += 1
      set({
        approvals: [], approvalsStatus: 'idle', approvalsError: undefined, approvalsReloading: false,
        barriers: [], barriersStatus: 'idle', barriersError: undefined, barriersReloading: false,
        locks: [], locksStatus: 'idle', locksError: undefined, locksReloading: false,
        operationsByRun: {}, operationsLoading: {}, revocations: [],
        runFilter: undefined, workflowFilter: undefined,
        decidingIds: [], reconcilingBarrierIds: [], reconcilingLockIds: [], revokingKeys: [],
      })
    },
  }
})

/** 深链 runId 过滤：审批按 runId；工作流闸门审批只有 runId 可对齐。 */
export function selectApprovalsByRun(approvals: readonly AgentApproval[], runId?: string): readonly AgentApproval[] {
  if (!runId) return approvals
  return approvals.filter((approval) => approval.runId === runId)
}

export function selectBarriersByRun(barriers: readonly AgentExecutionBarrier[], runId?: string): readonly AgentExecutionBarrier[] {
  if (!runId) return barriers
  return barriers.filter((barrier) => barrier.runId === runId)
}

/** 租约没有 workflowId 字段：runId 过滤之外不做工作流推断。 */
export function selectLocksByRun(locks: readonly AgentResourceLease[], runId?: string): readonly AgentResourceLease[] {
  if (!runId) return locks
  return locks.filter((lock) => lock.runId === runId)
}

/** 审批引用中的能力标识集合：撤销面板据此标注「审批引用中」（capability.ref 与 execution 计划）。 */
export function collectApprovalReferencedIds(approvals: readonly AgentApproval[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const approval of approvals) {
    if (approval.kind === 'workflow-gate') continue
    ids.add(approval.operation.capability.ref.id)
    if (approval.operation.execution !== undefined) {
      ids.add(approval.operation.execution.profile.id)
      if (approval.operation.execution.grant !== undefined) ids.add(approval.operation.execution.grant.id)
    }
  }
  return ids
}
