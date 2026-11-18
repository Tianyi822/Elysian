import { useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { captureAuthGeneration } from '../../utils/authGeneration'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { messageOf } from '../../utils/errorMessage'

/**
 * 删除会话确认弹窗：标题点名会话，说明聊天记录与运行历史一并清除且不可恢复；
 * 服务端拒绝时经全局通知透传中文文案，保留确认弹窗、不做本地清理。
 */
export function SessionRemoveDialog({ target, onClose }: {
  target: { id: string; title: string }
  onClose(): void
}) {
  const { agentConversation: api } = useGateway()
  const deleteSession = useAgentChatStore(state => state.deleteSession)
  const reportOperation = useAgentChatStore(state => state.reportOperation)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeTarget = useRef<string | null>(target.id)
  const requestVersion = useRef(0)

  useEffect(() => {
    activeTarget.current = target.id
    requestVersion.current += 1
    setRemoving(false)
    setError(null)
    return () => { activeTarget.current = null; requestVersion.current += 1 }
  }, [target.id])

  const submit = async () => {
    if (removing) return
    const targetId = target.id
    const owner = useAgentChatStore.getState().session?.id
    const version = ++requestVersion.current
    const authGeneration = captureAuthGeneration()
    const valid = () => activeTarget.current === targetId && requestVersion.current === version && captureAuthGeneration() === authGeneration
    setRemoving(true)
    setError(null)
    try {
      await deleteSession(api, targetId)
      if (valid()) onClose()
    } catch (error) {
      if (valid() && useAgentChatStore.getState().session?.id === owner) {
        const message = messageOf(error, '删除失败')
        setError(message)
        reportOperation(message)
      }
    } finally {
      if (valid()) setRemoving(false)
    }
  }

  return (
    <ConfirmDialog
      title={`删除会话「${target.title}」？`}
      description={<p className="mt-1.5 text-xs text-fg-muted">删除将立即终止该会话的运行和待执行任务，清除聊天记录与运行历史，且不可恢复。已发生的外部变更不会回滚。</p>}
      danger busy={removing} blockCloseWhileBusy confirmLabel={removing ? '删除中…' : '确认删除'}
      cancelClassName="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
      confirmClassName="rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-50"
      onClose={onClose}
      onConfirm={() => void submit()}
    >
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </ConfirmDialog>
  )
}
