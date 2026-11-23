import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useShellLayout } from '../../app/layout/ShellLayoutContext'
import { Button } from '../../components/Button'
import { List } from '../../components/icons'
import type { AgentConversationAdapter } from '../../contracts/agentChat'
import type { useAgentChatStore } from '../../stores/agentChatStore'
import { mediaQuery, observeMediaQuery } from '../../utils/mediaQuery'
import { ChatSessionList } from './ChatSessionList'

/** 会话列表开关固定在聊天页头内，仅保留读屏标签。 */
function SessionToggle({ expanded, controls, onClick, buttonRef }: {
  expanded: boolean
  controls: string
  onClick: () => void
  buttonRef?: Ref<HTMLButtonElement>
}) {
  const label = expanded ? '收起会话列表' : '打开会话列表'
  return <Button variant="outline" size="icon" pressFeedback={false} ref={buttonRef} type="button" className="chat-session-toggle" aria-label={label}
    aria-expanded={expanded} aria-controls={controls} onClick={onClick}>
    <List size={16} aria-hidden />
  </Button>
}

type Props = {
  api: AgentConversationAdapter
  loadSessions: ReturnType<typeof useAgentChatStore.getState>['loadSessions']
  onNew: () => void
  onSelect: (key: string) => void
  children: (toggle: ReactNode) => ReactNode
}

export function ChatSessionPane({ api, loadSessions, onNew, onSelect, children }: Props) {
  const shell = useShellLayout()
  const [listCollapsed, setListCollapsed] = useState(true)
  const [wide, setWide] = useState(() => mediaQuery('(min-width: 1100px)')?.matches ?? false)
  const [listRefreshing, setListRefreshing] = useState(false)
  const listTrigger = useRef<HTMLButtonElement>(null)
  const listDrawer = useRef<HTMLDivElement>(null)
  const restoreListFocus = useRef(false)
  const focusListTrigger = () => listTrigger.current?.focus()

  useEffect(() => {
    if (!listCollapsed || !restoreListFocus.current) return
    restoreListFocus.current = false
    focusListTrigger()
  }, [listCollapsed])
  useEffect(() => {
    const media = mediaQuery('(min-width: 1100px)')
    if (!media) return
    const update = () => setWide(media.matches)
    update()
    return observeMediaQuery(media, update)
  }, [])
  useEffect(() => {
    if (wide && shell.conversationDrawerOpen) shell.closeConversationDrawer()
  }, [wide, shell.conversationDrawerOpen, shell.closeConversationDrawer])
  const closeList = () => {
    restoreListFocus.current = !shell.conversationDrawerOpen
    setListCollapsed(true)
    shell.closeConversationDrawer()
  }
  const refreshList = () => { setListRefreshing(true); void loadSessions(api, { userInitiated: true }).finally(() => setListRefreshing(false)) }
  const list = <ChatSessionList onSelect={onSelect} onNew={onNew}
    onRefresh={refreshList} onMore={() => { void loadSessions(api, { more: true, userInitiated: true }) }} refreshing={listRefreshing}
    onClose={closeList} />
  // 会话栏默认收起，与主导航互不联动；手动展开后两栏可同开。
  const showSidebar = wide && !listCollapsed
  const expanded = showSidebar || shell.conversationDrawerOpen
  const toggle = <SessionToggle expanded={expanded} buttonRef={listTrigger}
    controls={wide ? 'chat-session-sidebar' : 'chat-session-drawer'} onClick={() => {
      if (expanded) closeList()
      else if (wide) setListCollapsed(false)
      else shell.openConversationDrawer()
    }} />

  return <div className="agent-workspace">
    {wide && <aside id="chat-session-sidebar" aria-label="会话列表"
      className="chat-session-sidebar" data-open={showSidebar || undefined}
      aria-hidden={!showSidebar || undefined} inert={!showSidebar}>{list}</aside>}
    <Dialog.Root open={shell.conversationDrawerOpen} onOpenChange={shell.setConversationDrawerOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-overlay motion-reduce:animate-none data-[state=open]:animate-drawer-overlay-in data-[state=closed]:animate-drawer-overlay-out" />
        <Dialog.Content ref={listDrawer} id="chat-session-drawer" aria-describedby={undefined} className="chat-session-drawer panel-surface fixed inset-y-0 left-0 z-50 flex flex-col rounded-none shadow-xl will-change-transform motion-reduce:animate-none data-[state=open]:animate-drawer-panel-in data-[state=closed]:animate-drawer-panel-out"
          onOpenAutoFocus={event => { event.preventDefault(); listDrawer.current?.focus() }}
          onCloseAutoFocus={event => { event.preventDefault(); if (!shell.navigationOpen) focusListTrigger() }}>
          <Dialog.Title className="sr-only">会话列表</Dialog.Title>{list}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    {children(toggle)}
  </div>
}
