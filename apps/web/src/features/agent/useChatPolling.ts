import { useEffect, useMemo } from 'react'
import type { AgentConversationAdapter } from '../../contracts/agentChat'
import { isChatRunActive, useAgentChatStore } from '../../stores/agentChatStore'
import { useSilentPolling } from '../../components/useSilentPolling'
import { subscribeWhileVisible } from '../../adapters/subscribeWhileVisible'

type ChatState = ReturnType<typeof useAgentChatStore.getState>

export function useChatDirectoryPolling(api: AgentConversationAdapter, loadSessions: ChatState['loadSessions']) {
  useSilentPolling(async () => {
    const state = useAgentChatStore.getState()
    if (state.listStatus !== 'loading' && (state.sessions.some(row => row.activeRunId || row.activeWorkflowId) || state.localSessions.some(row => row.pending))) {
      await loadSessions(api, { silent: true })
    }
  }, { intervalMs: 5000, enabled: api.available, scope: api })
}

export function useChatPolling(api: AgentConversationAdapter, chat: Pick<ChatState, 'session' | 'restoringAttachments' | 'sending' | 'refresh' | 'watchOutput'>, streamingRunId?: string) {
  const localSessionId = chat.session?.id
  const remoteSessionId = chat.session?.remote?.sessionId
  const detailScope = useMemo(() => [api, localSessionId, remoteSessionId], [api, localSessionId, remoteSessionId])
  useSilentPolling(async signal => {
    await chat.refresh(api, signal)
    const latest = useAgentChatStore.getState()
    return Boolean(isChatRunActive(latest.run) || latest.remoteSession?.activeRunId || latest.remoteSession?.activeWorkflowId || latest.session?.pending)
  }, { intervalMs: 1500, enabled: !!remoteSessionId && !chat.restoringAttachments && !chat.sending && api.available,
    immediate: true, abortOnHidden: true, scope: detailScope })

  useEffect(() => {
    if (!streamingRunId || !api.available) return
    return subscribeWhileVisible(() => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const connect = async () => {
        await chat.watchOutput(api, streamingRunId, controller.signal)
        if (!controller.signal.aborted) timer = setTimeout(() => { void connect() }, 1000)
      }
      void connect()
      return () => { controller.abort(); clearTimeout(timer) }
    })
  }, [api, streamingRunId, chat.watchOutput])
}
