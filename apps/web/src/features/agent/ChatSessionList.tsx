import { useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Tooltip from '@radix-ui/react-tooltip'
import { Pencil, Plus, X } from '../../components/icons'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { IconButton } from '../../components/IconButton'
import { LoadingState } from '../../components/states/StateViews'
import { agentChatSessionKey } from '../../contracts/agentChat'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { SessionRenameDialog } from './SessionRenameDialog'
import { SessionRemoveDialog } from './SessionRemoveDialog'

type SessionRow = { id: string; title: string; active: boolean; server: boolean }

const TOOLTIP_CONTENT_CLASS = 'z-[80] rounded border border-control-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg'

/**
 * 服务端会话行的编辑入口：hover 或键盘聚焦行内任意控件时经 CSS 显现（不占布局空间）。
 * 触发按钮同时是完整名称 Tooltip 与编辑菜单的触发器——指针与键盘同一入口；
 * 行右侧是完整名称弹窗的位置，编辑菜单因此向下弹出、右缘对齐图标；
 * 菜单浮层 Portal 到 body，抽屉内也能正常弹出并在关闭时归还焦点。
 */
function SessionRowEditMenu({ row, pending, sending, onRename, onDelete }: {
  row: SessionRow
  pending: boolean
  sending: boolean
  onRename(row: SessionRow): void
  onDelete(row: SessionRow): void
}) {
  const locked = row.active || pending
  return <DropdownMenu.Root>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label="编辑会话" disabled={sending}
            className="icon-button chat-session-edit text-fg-subtle hover:bg-surface-raised hover:text-fg">
            <Pencil size={14} aria-hidden />
          </button>
        </DropdownMenu.Trigger>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="right" sideOffset={4} className={TOOLTIP_CONTENT_CLASS}>
          编辑会话
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
    <DropdownMenu.Portal>
      <DropdownMenu.Content side="bottom" align="end" sideOffset={4} className="chat-session-menu">
        <DropdownMenu.Item className="chat-session-menu-item" onSelect={() => onRename(row)}>重命名</DropdownMenu.Item>
        <DropdownMenu.Item className="chat-session-menu-item chat-session-menu-remove" disabled={locked} onSelect={() => onDelete(row)}>
          <span>删除会话</span>
          {locked ? <span className="chat-session-menu-note">会话运行中或执行结果未确认时不能删除</span> : null}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}

export function ChatSessionList({ onSelect, onNew, onRefresh, onMore, onClose, refreshing }: {
  onSelect: (key: string) => void
  onNew: () => void
  onRefresh: () => void
  onMore: () => void
  onClose?: () => void
  refreshing: boolean
}) {
  const chat = useAgentChatStore()
  const [renameTarget, setRenameTarget] = useState<SessionRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SessionRow | null>(null)
  const selected = chat.session && agentChatSessionKey(chat.session)
  const local = new Map(chat.localSessions.map(row => [agentChatSessionKey(row), row]))
  const drafts = chat.localSessions.filter(row => !row.remote && (row.id === selected || row.draft || row.attachments.length))
  const rows: SessionRow[] = [...drafts.map(row => ({ id: row.id, title: row.draft || '新会话', active: false, server: false })),
    ...chat.sessions.map(row => ({ id: row.id, title: row.title || '新会话', active: !!(row.activeRunId || row.activeWorkflowId), server: true }))]
  // 页外的当前会话或发送待确认会话仍可直接回到，避免刷新第一页后丢失入口。
  for (const record of chat.localSessions) {
    const key = agentChatSessionKey(record)
    if (record.remote && (record.pending || key === selected) && !rows.some(row => row.id === key)) {
      rows.push({ id: key, title: key === selected ? chat.remoteSession?.title || '当前会话' : record.draft || '发送待确认', active: false, server: true })
    }
  }
  return <div className="chat-session-list">
    <div className="chat-session-heading"><span className="text-sm font-medium">会话</span>
      <RefreshButton label="刷新会话列表" variant="ghost" busy={refreshing} onPress={onRefresh} />
      {onClose && <IconButton label="关闭会话列表" variant="ghost" onPress={onClose}><X size={16} aria-hidden /></IconButton>}
    </div>
    <button type="button" className="chat-new chat-session-new" disabled={chat.sending} onClick={onNew}><Plus size={15} aria-hidden />新会话</button>
    <div className="chat-session-rows hover-scrollbar">
      {chat.listLoading && !rows.length ? <LoadingState label="正在读取会话…" /> : <>
        {!rows.length && <p className="px-3 py-5 text-sm text-fg-muted">暂无会话</p>}
        {rows.map(row => <div className="chat-session-item" key={row.id}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button type="button" className="chat-session-row" disabled={chat.sending}
                aria-current={row.id === selected ? 'page' : undefined} onClick={() => onSelect(row.id)}>
                <span className="truncate">{row.title}</span>
                {local.get(row.id)?.pending ? <span className="chat-session-status">发送待确认</span> : row.active ? <span className="chat-session-status">运行中</span> : null}
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content side="right" sideOffset={4} className={`${TOOLTIP_CONTENT_CLASS} max-w-[16rem] break-words`}>
                {row.title}
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
          {row.server && <SessionRowEditMenu row={row} pending={!!local.get(row.id)?.pending} sending={chat.sending}
            onRename={setRenameTarget} onDelete={setDeleteTarget} />}
        </div>)}
        {chat.listHasMore && <button className="chat-session-more" type="button" disabled={chat.listLoading} onClick={onMore}>{chat.listLoading ? '正在读取…' : '加载更多'}</button>}
      </>}
    </div>
    <BusyVeil busy={refreshing} />
    {renameTarget && <SessionRenameDialog target={renameTarget} onClose={() => setRenameTarget(null)} />}
    {deleteTarget && <SessionRemoveDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} />}
  </div>
}
