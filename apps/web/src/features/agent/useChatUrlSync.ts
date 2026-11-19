import { useEffect, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import type { AgentConversationAdapter } from '../../contracts/agentChat'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { messageOf } from '../../utils/errorMessage'

type NavigationState = Pick<ReturnType<typeof useAgentChatStore.getState>,
  'session' | 'restoringAttachments' | 'sending' | 'localSessions' | 'initialize' | 'newSession' | 'selectSession' | 'reportOperation'>

export function useChatUrlSync(api: AgentConversationAdapter, chat: NavigationState) {
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const [navigationReady, setNavigationReady] = useState<string | null>(null)
  const [navigationFailure, setNavigationFailure] = useState<string | null>(null)
  const [navigationAttempt, setNavigationAttempt] = useState(0)
  const requestedId = params.get('session') || undefined
  const routeState = location.state && typeof location.state === 'object' ? location.state : {}
  const requestedDraft = typeof routeState.agentDraftId === 'string' ? routeState.agentDraftId : undefined
  const session = chat.session

  useEffect(() => {
    let active = true
    setNavigationReady(null)
    setNavigationFailure(null)
    const restore = async () => {
      await chat.initialize(api, requestedId ?? requestedDraft)
      if (active) setNavigationReady(location.key)
    }
    void restore().catch(cause => {
      if (active) setNavigationFailure(`会话初始化失败：${messageOf(cause, '请重新读取会话。')}`)
    })
    return () => { active = false }
  }, [api, location.key, requestedId, requestedDraft, chat.initialize, navigationAttempt])
  useEffect(() => {
    if (navigationReady !== location.key || !session || chat.restoringAttachments || chat.sending) return
    const remoteId = session?.remote?.sessionId
    const draftId = remoteId ? undefined : session.id
    if (remoteId === requestedId && draftId === requestedDraft) return
    const next = new URLSearchParams(params)
    if (remoteId) next.set('session', remoteId)
    else next.delete('session')
    setParams(next, { replace: true, state: { ...routeState, agentDraftId: draftId } })
  }, [navigationReady, location.key, session?.id, session?.remote?.sessionId, requestedId, requestedDraft, chat.restoringAttachments, chat.sending, params, setParams])

  const newConversation = (onCreated: () => void) => {
    if (chat.sending) return
    setNavigationReady(null)
    void chat.newSession().then(() => {
      const next = new URLSearchParams(params); next.delete('session')
      setParams(next, { state: { ...routeState, agentDraftId: useAgentChatStore.getState().session?.id } })
      onCreated()
    }).catch(cause => chat.reportOperation(`新建会话失败：${messageOf(cause, '请重试。')}`))
  }
  const selectConversation = (key: string, onSelected: () => void) => {
    if (chat.sending) return
    setNavigationReady(null)
    if (chat.localSessions.some(row => row.id === key && !row.remote)) {
      void chat.selectSession(api, key).then(() => {
        const next = new URLSearchParams(params); next.delete('session')
        setParams(next, { state: { ...routeState, agentDraftId: key } })
      })
    } else { const next = new URLSearchParams(params); next.set('session', key); setParams(next) }
    onSelected()
  }

  return { navigationFailure, newConversation, selectConversation, retryNavigation: () => setNavigationAttempt(value => value + 1) }
}
