import { useId, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Tooltip from '@radix-ui/react-tooltip'
import { motion, useReducedMotion } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { Button, ButtonPressFeedback } from '../../components/Button'
import { Badge } from '../../components/easyui/Badge'
import { IconButton } from '../../components/IconButton'
import { MessageSquare, Pencil, Plus, Trash2, X } from '../../components/icons'
import { LoadingState } from '../../components/states/StateViews'
import { TOOLTIP_CONTENT_CLASS } from '../../components/tooltipStyles'
import { agentChatSessionKey } from '../../contracts/agentChat'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { SessionRenameDialog } from './SessionRenameDialog'
import { SessionRemoveDialog } from './SessionRemoveDialog'

type SessionRow = { id: string; title: string; active: boolean; server: boolean }


/**
 * 编辑菜单向下打开，让出会话标题 Tooltip 的右侧位置。
 */
function SessionRowEditMenu({ row, sending, onRename, onDelete }: {
  row: SessionRow
  sending: boolean
  onRename(row: SessionRow): void
  onDelete(row: SessionRow): void
}) {
  return <DropdownMenu.Root>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <DropdownMenu.Trigger asChild>
          <Button unstyled type="button" aria-label="编辑会话" className="chat-session-icon chat-session-edit">
            <Pencil size={14} aria-hidden />
          </Button>
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
        <DropdownMenu.Item className="chat-session-menu-item" disabled={sending} onSelect={() => onRename(row)}>
          <Pencil size={14} aria-hidden />重命名
        </DropdownMenu.Item>
        <DropdownMenu.Item className="chat-session-menu-item chat-session-menu-remove" onSelect={() => onDelete(row)}>
          <Trash2 size={14} aria-hidden />删除会话
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}

export function ChatSessionList({ onSelect, onNew, onRetry, onMore, onClose }: {
  onSelect: (key: string) => void
  onNew: () => void
  onRetry: () => void
  onMore: () => void
  onClose?: () => void
}) {
  const chat = useAgentChatStore(useShallow(state => ({
    selected: state.session && agentChatSessionKey(state.session),
    remoteTitle: state.remoteSession?.title,
    localSessions: state.localSessions,
    sessions: state.sessions,
    sending: state.sending,
    listStatus: state.listStatus,
    listErrorMessage: state.listErrorMessage,
    listHasMore: state.listHasMore,
  })))
  const [renameTarget, setRenameTarget] = useState<SessionRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SessionRow | null>(null)
  const selectionId = useId()
  const reduceMotion = useReducedMotion()
  const selected = chat.selected
  const loading = chat.listStatus === 'loading'
  const local = new Map(chat.localSessions.map(row => [agentChatSessionKey(row), row]))
  const drafts = chat.localSessions.filter(row => !row.remote && (row.id === selected || row.draft || row.attachments.length))
  const rows: SessionRow[] = [...drafts.map(row => ({ id: row.id, title: row.draft || '新会话', active: false, server: false })),
    ...chat.sessions.map(row => ({ id: row.id, title: row.title || '新会话', active: !!(row.activeRunId || row.activeWorkflowId), server: true }))]
  // 页外的当前会话或发送待确认会话仍可直接回到，避免刷新第一页后丢失入口。
  for (const record of chat.localSessions) {
    const key = agentChatSessionKey(record)
    if (record.remote && (record.pending || key === selected) && !rows.some(row => row.id === key)) {
      rows.push({ id: key, title: key === selected ? chat.remoteTitle || '当前会话' : record.draft || '发送待确认', active: false, server: true })
    }
  }
  return <ButtonPressFeedback value={false}><div className="chat-session-list">
    <header className="chat-session-heading">
      <h2>会话</h2>
      {onClose && <IconButton asChild label="关闭会话列表">
        <Button unstyled type="button" aria-label="关闭会话列表" className="chat-session-icon" onClick={onClose}>
          <X size={16} aria-hidden />
        </Button>
      </IconButton>}
    </header>
    <Button size="sm" type="button" className="chat-session-new" disabled={chat.sending}
      leftIcon={<Plus size={16} aria-hidden />} onClick={onNew}>新会话</Button>
    <div className="chat-session-rows hover-scrollbar">
      {loading && !rows.length ? <LoadingState label="正在读取会话…" /> : <>
        {chat.listErrorMessage && <div role="alert" className="chat-session-error">
          <p className="font-medium">会话暂时无法读取</p>
          <p className="text-xs text-fg-muted">{chat.listErrorMessage}</p>
          <Button variant="outline" size="sm" type="button" disabled={loading} onClick={onRetry}>重试读取会话列表</Button>
        </div>}
        {!rows.length && !chat.listErrorMessage && <p className="px-3 py-5 text-sm text-fg-muted">暂无会话</p>}
        {rows.length > 0 && <ul className="chat-session-items" role="list">
          {rows.map(row => {
            const current = row.id === selected
            const pending = !!local.get(row.id)?.pending
            return <li className="chat-session-item" key={row.id} data-editable={row.server || undefined}>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <Button unstyled type="button" className="chat-session-row" disabled={chat.sending}
                    aria-current={current ? 'page' : undefined} onClick={() => onSelect(row.id)}>
                    {current && <motion.span aria-hidden className="chat-session-selection"
                      layoutId={reduceMotion ? undefined : selectionId}
                      transition={{ type: 'spring', stiffness: 420, damping: 36, mass: 0.8 }} />}
                    <MessageSquare aria-hidden size={16} className="chat-session-row-icon" />
                    <span className="chat-session-copy">
                      <span className="truncate">{row.title}</span>
                      {(pending || row.active) && <Badge className="h-[18px] px-1.5 text-[11px]" dot animateChanges={false}
                        tone={pending ? 'warning' : 'neutral'}>{pending ? '发送待确认' : '运行中'}</Badge>}
                    </span>
                  </Button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content side="right" sideOffset={4} className={`${TOOLTIP_CONTENT_CLASS} max-w-[16rem] break-words`}>
                    {row.title}
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
              {row.server && <SessionRowEditMenu row={row} sending={chat.sending}
                onRename={setRenameTarget} onDelete={setDeleteTarget} />}
            </li>
          })}
        </ul>}
        {chat.listHasMore && <Button variant="ghost" className="chat-session-more" type="button" isLoading={loading} loadingText="正在读取…" onClick={onMore}>加载更多</Button>}
      </>}
    </div>
    {renameTarget && <SessionRenameDialog target={renameTarget} onClose={() => setRenameTarget(null)} />}
    {deleteTarget && <SessionRemoveDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} />}
  </div></ButtonPressFeedback>
}
