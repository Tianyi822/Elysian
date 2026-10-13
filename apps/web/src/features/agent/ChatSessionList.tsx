import { Plus, PanelLeftClose } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { LoadingState } from '../../components/states/StateViews'
import { agentChatSessionKey } from '../../contracts/agentChat'
import { useAgentChatStore } from '../../stores/agentChatStore'

export function ChatSessionList({ onSelect, onNew, onClose, onRefresh, onMore, refreshing }: {
  onSelect: (key: string) => void
  onNew: () => void
  onClose: () => void
  onRefresh: () => void
  onMore: () => void
  refreshing: boolean
}) {
  const chat = useAgentChatStore()
  const selected = chat.session && agentChatSessionKey(chat.session)
  const local = new Map(chat.localSessions.map(row => [agentChatSessionKey(row), row]))
  const drafts = chat.localSessions.filter(row => !row.remote && (row.id === selected || row.draft || row.attachments.length))
  const rows = [...drafts.map(row => ({ id: row.id, title: row.draft || '新会话', active: false })),
    ...chat.sessions.map(row => ({ id: row.id, title: row.title || '新会话', active: !!(row.activeRunId || row.activeWorkflowId) }))]
  // 页外的当前会话或发送待确认会话仍可直接回到，避免刷新第一页后丢失入口。
  for (const record of chat.localSessions) {
    const key = agentChatSessionKey(record)
    if (record.remote && (record.pending || key === selected) && !rows.some(row => row.id === key)) {
      rows.push({ id: key, title: key === selected ? chat.remoteSession?.title || '当前会话' : record.draft || '发送待确认', active: false })
    }
  }
  return <div className="chat-session-list">
    <div className="chat-session-heading"><span className="text-sm font-medium">会话</span>
      <RefreshButton label="刷新会话列表" variant="ghost" busy={refreshing} onPress={onRefresh} />
      <IconButton label="收起会话列表" variant="ghost" onPress={onClose}><PanelLeftClose size={16} aria-hidden /></IconButton>
    </div>
    <button type="button" className="chat-new chat-session-new" disabled={chat.sending} onClick={onNew}><Plus size={15} aria-hidden />新会话</button>
    <div className="chat-session-rows hover-scrollbar">
      {chat.listError && <div role="alert" className="px-3 py-2 text-xs text-danger">{chat.listError}</div>}
      {chat.listLoading && !rows.length ? <LoadingState label="正在读取会话…" /> : <>
        {!rows.length && <p className="px-3 py-5 text-sm text-fg-muted">暂无会话</p>}
        {rows.map(row => <button type="button" className="chat-session-row" key={row.id} disabled={chat.sending}
          aria-current={row.id === selected ? 'page' : undefined} onClick={() => onSelect(row.id)} title={row.title}>
          <span className="truncate">{row.title}</span>
          {local.get(row.id)?.pending ? <span className="chat-session-status">发送待确认</span> : row.active ? <span className="chat-session-status">运行中</span> : null}
        </button>)}
        {chat.listHasMore && <button className="chat-session-more" type="button" disabled={chat.listLoading} onClick={onMore}>{chat.listLoading ? '正在读取…' : '加载更多'}</button>}
      </>}
    </div>
    <BusyVeil busy={refreshing} />
  </div>
}
