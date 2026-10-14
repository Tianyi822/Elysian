import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { useAgentChatStore } from '../../stores/agentChatStore'

/**
 * 删除会话确认弹窗：标题点名会话，说明聊天记录与运行历史一并清除且不可恢复；
 * 服务端拒绝（如结果未确认的执行）时错误行内透传中文文案，不做任何本地清理。
 */
export function SessionRemoveDialog({ target, onClose }: {
  target: { id: string; title: string }
  onClose(): void
}) {
  const { agentConversation: api } = useGateway()
  const deleteSession = useAgentChatStore(state => state.deleteSession)
  const [removing, setRemoving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>()

  useEffect(() => { setErrorMessage(undefined) }, [target.id])

  const submit = async () => {
    setRemoving(true)
    setErrorMessage(undefined)
    try {
      await deleteSession(api, target.id)
      onClose()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '删除失败')
    } finally {
      setRemoving(false)
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
          {errorMessage ? <p role="alert" className="mt-2 text-xs text-danger">{errorMessage}</p> : null}
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
