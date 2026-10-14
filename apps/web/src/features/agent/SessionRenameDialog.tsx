import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { useAgentChatStore } from '../../stores/agentChatStore'

/**
 * 会话重命名弹窗：预填当前标题，空值与超长在前端先挡（均按 TrimSpace 后口径）；
 * 提交以服务端 200 回执为权威，失败留在弹窗内行内展示、可修改后重试。
 */
export function SessionRenameDialog({ target, onClose }: {
  target: { id: string; title: string }
  onClose(): void
}) {
  const { agentConversation: api } = useGateway()
  const renameSession = useAgentChatStore(state => state.renameSession)
  const [name, setName] = useState(target.title)
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>()

  useEffect(() => {
    // 换了目标会话就重置表单：弹窗复用同一份组件状态。
    setName(target.title)
    setErrorMessage(undefined)
  }, [target.id, target.title])

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setErrorMessage('名称不能为空')
      return
    }
    if (new TextEncoder().encode(trimmed).length > 200) {
      setErrorMessage('标题不能超过 200 字节')
      return
    }
    setSubmitting(true)
    setErrorMessage(undefined)
    try {
      await renameSession(api, target.id, trimmed)
      onClose()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '重命名失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={next => { if (!next && !submitting) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">重命名会话</Dialog.Title>
          <form onSubmit={event => { event.preventDefault(); void submit() }}>
            <label htmlFor="agent-session-rename-input" className="mt-3 block text-xs text-fg-muted">
              会话名称
            </label>
            <input
              id="agent-session-rename-input"
              value={name}
              onChange={event => setName(event.target.value)}
              autoFocus
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle"
            />
            {errorMessage ? <p role="alert" className="mt-2 text-xs text-danger">{errorMessage}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
              >
                确认重命名
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
