import { createStore } from 'zustand'
import type { AgentAccessDecisionInput, AgentApproval } from '@elysian/contracts'
import type { AgentChatGovernance } from '../contracts/agentChat'
import { subscribeWhileVisible } from '../adapters/subscribeWhileVisible'
import { messageOf } from '../utils/errorMessage'
import { randomId } from '../utils/randomId'
import { readAuthorizationPending, saveAuthorizationPending } from './authorizationPending'
import { useMessageStore } from './messageStore'
import { createRequestGuard } from './requestGuard'

type ChatApprovalsState = {
  approvals: readonly AgentApproval[]
  pending: Record<string, AgentAccessDecisionInput>
  errorMessage?: string
  acting: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  observe(): () => void
  load(): void
  decide(id: string, decision: 'approved' | 'denied', onChanged: () => void): Promise<void>
  decideAccess(approval: AgentApproval, decision: AgentAccessDecisionInput['decision'], onChanged: () => void): Promise<void>
}

/** 单个 Run 的审批读取与决定。提交时暂停旧读取，结清后再核对服务端状态。 */
export function createChatApprovalsStore(api: AgentChatGovernance | undefined, runId: string) {
  return createStore<ChatApprovalsState>((set, get) => {
    const lifetime = createRequestGuard()
    let isObserved: (() => boolean) | undefined
    let stopReading: (() => void) | undefined

    function savePending(pending: ChatApprovalsState['pending']) {
      saveAuthorizationPending(runId, pending)
      set({ pending })
    }

    function readWhileVisible(current: () => boolean) {
      if (!api) return
      const governance = api
      stopReading = subscribeWhileVisible(() => {
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        const canRead = () => current() && !controller.signal.aborted
        async function read() {
          try {
            const rows = await governance.approvals(runId, controller.signal)
            if (!canRead()) return
            const approvals = rows.filter(row => row.kind !== 'workflow-gate' && (row.status === 'pending' || row.status === 'approved'))
            const pending = Object.fromEntries(Object.entries(get().pending).filter(([id, input]) => approvals.some(row =>
              row.id === id && row.kind !== 'workflow-gate' && row.status === 'pending' &&
              row.access?.revision === input.expectedRevision && row.access.digest === input.expectedDigest,
            )))
            saveAuthorizationPending(runId, pending)
            set({ approvals, pending, status: 'ready', errorMessage: undefined })
          } catch (cause) {
            if (canRead()) set({ status: 'error', errorMessage: messageOf(cause, '读取审批失败') })
          } finally {
            if (canRead()) timer = setTimeout(() => void read(), 2000)
          }
        }
        void read()
        return () => { controller.abort(); clearTimeout(timer) }
      })
    }

    async function submit(request: () => Promise<AgentApproval>, onReceived: (receipt: AgentApproval) => void, fallback: string) {
      const current = isObserved
      if (!current?.() || get().acting) return
      stopReading?.()
      stopReading = undefined
      set({ acting: true, errorMessage: undefined })
      try {
        const receipt = await request()
        if (!current()) return
        set(state => ({ approvals: state.approvals.map(row => row.id === receipt.id ? receipt : row) }))
        onReceived(receipt)
      } catch (cause) {
        if (current()) set({ errorMessage: messageOf(cause, fallback) })
      } finally {
        if (current()) {
          set({ acting: false, status: 'loading', approvals: [] })
          readWhileVisible(current)
        }
      }
    }

    return {
      approvals: [], pending: readAuthorizationPending(runId), acting: false, status: 'idle',
      observe() {
        const current = lifetime.replace()
        isObserved = current
        get().load()
        return () => {
          lifetime.invalidate()
          isObserved = undefined
          stopReading?.()
          stopReading = undefined
        }
      },
      load() {
        if (get().acting) return
        stopReading?.()
        set({ approvals: [], errorMessage: undefined, status: api ? 'loading' : 'idle' })
        if (isObserved?.()) readWhileVisible(isObserved)
      },
      async decide(id, decision, onChanged) {
        if (!api) return
        await submit(() => api.decide(id, decision), receipt => {
          useMessageStore.getState().notify({ tone: 'success', message: receipt.status === 'approved' ? '操作已批准，等待执行。' : '操作已拒绝。' })
          onChanged()
        }, '审批结果未确认，请重新读取')
      },
      async decideAccess(approval, decision, onChanged) {
        if (!api || approval.kind === 'workflow-gate' || !approval.access) return
        const input = get().pending[approval.id] ?? {
          requestId: randomId(), expectedRevision: approval.access.revision, expectedDigest: approval.access.digest, decision,
        }
        await submit(() => {
          savePending({ ...get().pending, [approval.id]: input })
          return api.decideAccess(approval.id, input)
        }, () => {
          const pending = { ...get().pending }
          delete pending[approval.id]
          savePending(pending)
          onChanged()
        }, '确认结果未知，请重新读取')
      },
    }
  })
}
