import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { isValidFileName } from '@elysian/contracts'
import type { FileEntry } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useFilesStore } from '../../stores/filesStore'

/**
 * 重命名对话框：预填现名，名称判据在前端先挡一道（非空、不含斜杠），
 * 重名与否由数据层判定、错误行内展示，不打进通知。
 */
export function RenameDialog({
  entry,
  entryPath,
  onClose,
}: {
  entry: FileEntry
  entryPath: string
  onClose(): void
}) {
  const gateway = useGateway()
  const rename = useFilesStore((s) => s.rename)
  const [name, setName] = useState(entry.name)
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>()

  useEffect(() => {
    // 换了待重命名的条目就重置表单：对话框复用同一份组件状态。
    setName(entry.name)
    setErrorMessage(undefined)
  }, [entry.name, entryPath])

  const submit = async () => {
    const trimmed = name.trim()
    if (!isValidFileName(trimmed)) {
      setErrorMessage('名称不能为空，也不能包含 /')
      return
    }
    setSubmitting(true)
    setErrorMessage(undefined)
    try {
      await rename(gateway, entryPath, trimmed)
      onClose()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '重命名失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface-raised p-4 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">重命名「{entry.name}」</Dialog.Title>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <label htmlFor="files-rename-input" className="mt-3 block text-xs text-fg-muted">
              新名称
            </label>
            <input
              id="files-rename-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              className="mt-1 h-[34px] w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle"
            />
            {errorMessage ? (
              <p role="alert" className="mt-2 text-xs text-danger">
                {errorMessage}
              </p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
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
