import type { ApprovalOutcome, ApprovalRequest } from '@elysian/contracts'
import { create } from 'zustand'
import type { ApprovalAdapter } from '../contracts/adapters'

type ApprovalQueueState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  approvals: readonly ApprovalRequest[]
  /** 列表加载失败的原因。 */
  errorMessage?: string
  /** 最近一次审批操作失败的原因，与列表加载失败分开呈现。 */
  actionError?: string
  /** 最近一次审批操作成功的说明。状态筛选下条目会离开列表，这时它就是唯一的反馈。 */
  lastDecisionNote?: string
  /** 正在处理的审批请求，用于禁用按钮、避免重复提交。 */
  busyApprovalId?: string
  load: (adapter: ApprovalAdapter) => Promise<void>
  decide: (
    adapter: ApprovalAdapter,
    requestId: string,
    decision: { outcome: ApprovalOutcome; note?: string },
  ) => Promise<void>
}

export const useApprovalQueueStore = create<ApprovalQueueState>((set) => ({
  status: 'idle',
  approvals: [],
  async load(adapter) {
    set({ status: 'loading', errorMessage: undefined })
    try {
      const approvals = await adapter.list()
      set({ status: 'ready', approvals })
    } catch (error) {
      set({
        status: 'error',
        approvals: [],
        errorMessage: error instanceof Error ? error.message : '读取审批队列失败',
      })
    }
  },
  async decide(adapter, requestId, decision) {
    set({ busyApprovalId: requestId, actionError: undefined, lastDecisionNote: undefined })
    try {
      const updated = await adapter.decide(requestId, decision)
      const decisionLabel = decision.outcome === 'rejected' ? '已拒绝' : '已批准'
      set((state) => ({
        busyApprovalId: undefined,
        lastDecisionNote: `${decisionLabel}：${updated.actionTitle}（动作仍待接入真实执行）`,
        approvals: state.approvals.map((approval) =>
          approval.id === updated.id ? updated : approval,
        ),
      }))
    } catch (error) {
      set({
        busyApprovalId: undefined,
        actionError: error instanceof Error ? error.message : '审批操作失败',
      })
    }
  },
}))
