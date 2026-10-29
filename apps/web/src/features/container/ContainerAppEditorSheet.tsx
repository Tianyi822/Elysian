import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useState } from 'react'
import { Check, Loader2, TriangleAlert, X } from '../../components/icons'
import { containerAppFilePath } from '@elysian/contracts'
import type { ContainerAppFile } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { IconButton } from '../../components/IconButton'
import { CopyButton } from '../../components/CopyButton'
import { CTL_DANGER, CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { useContainerAppsStore } from '../../stores/containerAppsStore'
import { isComposeFile } from '../../stores/containerAppsStore'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'

/** 编辑抽屉的读取状态；失败要在抽屉里说清楚并能重试，不能只留一个空框。 */
type Loaded = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; content: string }

/**
 * 工作区里的文本文件编辑器。
 *
 * 只服务工作区目录，不是通用文件管理器的写入口（那侧的写禁区不覆盖 /etc 这类系统路径）。
 * 保存后若该文件是 compose，store 会自动再跑一次引用自检。
 */
export function ContainerAppEditorSheet({
  slug,
  path,
  onClose,
}: {
  slug: string
  path: string
  onClose: () => void
}) {
  const gateway = useGateway()
  const writing = useContainerAppsStore((s) => s.writing)
  const save = useContainerAppsStore((s) => s.save)
  const app = useContainerAppsStore((s) => s.apps.find((candidate) => candidate.slug === slug))

  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  const [draft, setDraft] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [discardOpen, setDiscardOpen] = useState(false)
  useFeedbackMessage(loaded.kind === 'error' ? loaded.message : null)

  const file: ContainerAppFile | undefined = app?.files.find((candidate) => candidate.path === path)
  const dirty = loaded.kind === 'ready' && draft !== loaded.content
  const saving = writing === `${slug}/${path}`
  // 点外部一律不关：正在编辑的配置不该因为一次误点丢掉。
  const closeBlocked = dirty || saving

  const submit = () => {
    void save(gateway, slug, path, draft).then((ok) => {
      // 保存成功才把基准对齐到草稿，dirty 归零；失败保留草稿与原基准。
      if (ok) setLoaded({ kind: 'ready', content: draft })
    })
  }

  useEffect(() => {
    let cancelled = false
    setLoaded({ kind: 'loading' })
    gateway.containers
      .readAppContent(slug, path)
      .then((result) => {
        if (cancelled) return
        setLoaded({ kind: 'ready', content: result.content })
        setDraft(result.content)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setLoaded({
            kind: 'error',
            message: cause instanceof Error ? cause.message : '读取文件内容失败',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [gateway, slug, path, attempt])

  const requestClose = () => {
    if (closeBlocked) setDiscardOpen(true)
    else onClose()
  }

  // 清单还没带上该文件时（刚保存或正在刷新）回落到工作区目录拼接，路径始终可读可抄。
  const absolutePath = app && file ? containerAppFilePath(app, file) : `${slug}/${path}`

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) requestClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[58] bg-overlay" />
        <Dialog.Content
          aria-describedby="app-editor-description"
          onPointerDownOutside={(event) => {
            if (closeBlocked) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (closeBlocked) event.preventDefault()
          }}
          onEscapeKeyDown={(event) => {
            // Esc 不静默丢弃：有未保存改动时把「要不要放弃」问出来。
            if (closeBlocked) {
              event.preventDefault()
              setDiscardOpen(true)
            }
          }}
          className="fixed inset-y-0 right-0 z-[59] flex w-full max-w-2xl flex-col panel-surface rounded-none shadow-xl"
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-sm font-medium">
                编辑 <span className="font-mono">{path}</span>
              </Dialog.Title>
              <p id="app-editor-description" className="mt-1 text-xs text-fg-muted">
                {isComposeFile(path) ? '保存后覆盖该文件，并自动重跑引用自检。' : '保存后覆盖工作区里的该文件。'}
              </p>
              <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-subtle" title={absolutePath}>
                  {absolutePath}
                </code>
                <CopyButton label="复制真实路径" value={absolutePath} tooltip="复制该文件的真实绝对路径" />
              </div>
            </div>
            <IconButton label="关闭编辑器" variant="ghost" onPress={requestClose}>
              <X aria-hidden size={15} />
            </IconButton>
          </div>

          {discardOpen ? (
            <div role="alert" className="flex items-center gap-2 border-b border-line bg-warning/10 px-4 py-2 text-xs text-warning">
              <TriangleAlert aria-hidden size={13} className="shrink-0" />
              <span className="min-w-0 flex-1">有未保存的修改，关闭后这部分改动会丢失。</span>
              <button type="button" onClick={() => setDiscardOpen(false)} className={CTL_SECONDARY}>
                继续编辑
              </button>
              <button
                type="button"
                onClick={() => {
                  setDiscardOpen(false)
                  onClose()
                }}
                className={CTL_DANGER}
              >
                放弃修改
              </button>
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
            {loaded.kind === 'loading' ? (
              <p role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-fg-muted">
                <Loader2 aria-hidden size={15} className="animate-spin" />
                正在读取文件内容…
              </p>
            ) : loaded.kind === 'error' ? (
              <div role="alert" className="flex flex-col items-center gap-2 py-10 text-center">
                <TriangleAlert aria-hidden size={18} className="text-danger" />
                <p className="text-sm text-fg">{loaded.message}</p>
                <button type="button" onClick={() => setAttempt((n) => n + 1)} className={`${CTL_SECONDARY} px-2`}>
                  重试
                </button>
              </div>
            ) : (
              <>
                <label htmlFor="app-editor-content" className="sr-only">
                  {path} 的文件内容
                </label>
                <textarea
                  id="app-editor-content"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  spellCheck={false}
                  className="min-h-0 flex-1 resize-none rounded-lg border border-control-line bg-surface-raised px-3 py-2 font-mono text-xs text-fg transition-colors focus-visible:border-accent"
                />
              </>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
            <p className="text-xs text-fg-subtle">
              {dirty ? '有未保存的修改。' : '内容与磁盘一致。'}
            </p>
            <div className="flex shrink-0 gap-2">
              <button type="button" onClick={requestClose} className={`${CTL_SECONDARY} px-3`}>
                关闭
              </button>
              <button
                type="button"
                disabled={!dirty || saving || loaded.kind !== 'ready'}
                onClick={submit}
                className={`${CTL_PRIMARY} gap-1.5 px-3`}
              >
                {saving ? <Loader2 aria-hidden size={13} className="animate-spin" /> : <Check aria-hidden size={13} />}
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
