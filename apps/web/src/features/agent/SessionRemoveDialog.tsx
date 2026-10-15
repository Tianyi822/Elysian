import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { useAgentChatStore } from '../../stores/agentChatStore'

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
  const activeTarget = useRef<string | null>(target.id)
  const requestVersion = useRef(0)

  useEffect(() => {
    activeTarget.current = target.id
    requestVersion.current += 1
    setRemoving(false)
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
    try {
      await deleteSession(api, targetId)
      if (valid()) onClose()
    } catch (error) {
      if (valid() && useAgentChatStore.getState().session?.id === owner) reportOperation(error instanceof Error ? error.message : '删除失败')
    } finally {
      if (valid()) setRemoving(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={next => { if (!next && !removing) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">删除会话「{target.title}」？</Dialog.Title>
          <p className="mt-1.5 text-xs text-fg-muted">删除后该会话的聊天记录与运行历史将一并清除，且不可恢复。</p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={removing}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              disabled={removing}
              onClick={() => { void submit() }}
              className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {removing ? '删除中…' : '确认删除'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
