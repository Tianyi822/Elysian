import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { useAgentChatStore } from '../../stores/agentChatStore'

/**
 * 会话重命名弹窗：预填当前标题，空值与超长在前端先挡（均按 TrimSpace 后口径）；
 * 提交以服务端 200 回执为权威，失败经全局通知反馈、保留输入以便重试。
 */
export function SessionRenameDialog({ target, onClose }: {
  target: { id: string; title: string }
  onClose(): void
}) {
  const { agentConversation: api } = useGateway()
  const renameSession = useAgentChatStore(state => state.renameSession)
  const reportOperation = useAgentChatStore(state => state.reportOperation)
  const [name, setName] = useState(target.title)
  const [submitting, setSubmitting] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const activeTarget = useRef<string | null>(target.id)
  const requestVersion = useRef(0)

  useEffect(() => {
    // 换了目标会话就重置表单：弹窗复用同一份组件状态。
    activeTarget.current = target.id
    requestVersion.current += 1
    setName(target.title)
    setInvalid(false)
    setSubmitting(false)
    return () => { activeTarget.current = null; requestVersion.current += 1 }
  }, [target.id, target.title])

  const submit = async () => {
    if (submitting) return
    const trimmed = name.trim()
    if (!trimmed) {
      setInvalid(true)
      reportOperation('名称不能为空')
      input.current?.focus()
      return
    }
    if (new TextEncoder().encode(trimmed).length > 200) {
      setInvalid(true)
      reportOperation('标题不能超过 200 字节')
      input.current?.focus()
      return
    }
    const targetId = target.id
    const owner = useAgentChatStore.getState().session?.id
    const version = ++requestVersion.current
    const authGeneration = captureAuthGeneration()
    const valid = () => activeTarget.current === targetId && requestVersion.current === version && captureAuthGeneration() === authGeneration
    setSubmitting(true)
    setInvalid(false)
    try {
      await renameSession(api, targetId, trimmed)
      if (valid()) onClose()
    } catch (error) {
      if (valid() && useAgentChatStore.getState().session?.id === owner) {
        reportOperation(error instanceof Error ? error.message : '重命名失败')
        input.current?.focus()
      }
    } finally {
      if (valid()) setSubmitting(false)
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
              ref={input}
              id="agent-session-rename-input"
              value={name}
              aria-invalid={invalid || undefined}
              onChange={event => { setName(event.target.value); setInvalid(false) }}
              autoFocus
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle"
            />
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
