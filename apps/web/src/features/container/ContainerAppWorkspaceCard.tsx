import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, Copy, File as FileIcon, Folder, Pencil, ShieldCheck, Trash2, Upload } from '../../components/icons'
import { containerAppFilePath } from '@elysian/contracts'
import type { ContainerApp, ContainerAppFile } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useClipboardCopy } from '../../components/CopyButton'
import { BusyVeil } from '../../components/RefreshState'
import { IconButton } from '../../components/IconButton'
import { CTL_CARD_ACTION, CTL_DANGER, CTL_SECONDARY } from '../../components/formControl'
import { formatDate } from '../../components/format'
import {
  appWritingKey,
  isComposeFile,
  useContainerAppsStore,
  WORKSPACE_WRITING_PATH,
} from '../../stores/containerAppsStore'
import { ComposeCheckPanel } from './ComposeCheckPanel'

/** 待确认的删除目标：工作区连目录一起删，单文件只删自己。 */
type Pending = { kind: 'app' } | { kind: 'file'; path: string } | null

/** 与镜像表同档的体积表达：工作区文件都是配置文本，不需要更大单位。 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function CopyPathButton({ value, label }: { value: string; label: string }) {
  const { copied, copy } = useClipboardCopy()
  return (
    <button
      type="button"
      onClick={() => void copy(value, label)}
      title={`复制${label}`}
      aria-label={`复制${label}`}
      className="icon-button inline-flex size-6 shrink-0 items-center justify-center text-fg-subtle transition-colors hover:bg-surface-raised hover:text-fg"
    >
      {copied ? <Check aria-hidden size={13} className="text-success" /> : <Copy aria-hidden size={13} />}
    </button>
  )
}

/**
 * 单个应用工作区卡片。
 *
 * 卡片把真实绝对路径摆在最显眼的位置：上传这些文件的意义就在于「compose 里能写到它」，
 * 所以目录一行、每个文件一行都给完整路径与复制入口，自检结果里也是同一个形状。
 */
export function ContainerAppWorkspaceCard({
  app,
  onEdit,
}: {
  app: ContainerApp
  onEdit(slug: string, path: string): void
}) {
  const gateway = useGateway()
  const writing = useContainerAppsStore((s) => s.writing)
  const check = useContainerAppsStore((s) => s.check)
  const upload = useContainerAppsStore((s) => s.upload)
  const remove = useContainerAppsStore((s) => s.remove)
  const removeFile = useContainerAppsStore((s) => s.removeFile)
  const runCheck = useContainerAppsStore((s) => s.runCheck)
  const clearCheck = useContainerAppsStore((s) => s.clearCheck)
  const [pending, setPending] = useState<Pending>(null)

  const directoryInputRef = useRef<HTMLInputElement>(null)
  // webkitdirectory 不在 React 的类型里，只能在节点上直接设属性。
  useEffect(() => {
    directoryInputRef.current?.setAttribute('webkitdirectory', '')
  }, [])

  const batchBusy = writing === appWritingKey(app.slug, WORKSPACE_WRITING_PATH)
  const checkHere = check?.slug === app.slug ? check : null

  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    // 清空 value：连续选同一份文件也要能再次触发 change。
    event.target.value = ''
    if (files.length > 0) void upload(gateway, app.slug, files)
  }

  return (
    <li aria-label={`应用工作区 ${app.displayName}`} className="h-full">
      <div className="busy-host h-full">
        <BusyVeil busy={batchBusy} />
        <article className="flex h-full flex-col gap-3 panel-surface px-4 py-3.5">
          <header className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-medium">{app.displayName}</h3>
              <p className="mt-0.5 font-mono text-xs text-fg-subtle">
                {app.slug} · {formatDate(app.createdAt)} 建
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <input
                type="file"
                multiple
                className="sr-only"
                id={`app-files-${app.slug}`}
                onChange={pick}
              />
              <label htmlFor={`app-files-${app.slug}`} className={`${CTL_CARD_ACTION} cursor-pointer`}>
                <Upload aria-hidden size={13} />
                上传文件
              </label>
              <input
                ref={directoryInputRef}
                type="file"
                multiple
                className="sr-only"
                id={`app-directory-${app.slug}`}
                onChange={pick}
              />
              <label htmlFor={`app-directory-${app.slug}`} className={`${CTL_CARD_ACTION} cursor-pointer`}>
                <Folder aria-hidden size={13} />
                上传目录
              </label>
              <IconButton
                label="删除工作区"
                variant="ghost"
                tone="danger-hover"
                onPress={() => setPending({ kind: 'app' })}
              >
                <Trash2 aria-hidden size={14} />
              </IconButton>
            </div>
          </header>

          {/* 真实路径是这一屏的主角：单独一块，永远完整可读，能整条复制。 */}
          <div className="rounded-lg border border-line bg-surface px-2.5 py-2">
            <p className="text-xs font-medium text-fg-muted">工作区真实路径</p>
            <div className="mt-1 flex items-center gap-1.5">
              <code className="min-w-0 flex-1 break-all font-mono text-xs text-fg">{app.directory}</code>
              <CopyPathButton value={app.directory} label="工作区真实路径" />
            </div>
            <p className="mt-1.5 text-xs text-fg-subtle">
              compose 里 <span className="font-mono">./</span> 开头的引用请以该目录为根；文件不在这里就挂不上。
            </p>
          </div>

          {app.files.length === 0 ? (
            <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
              <FileIcon aria-hidden size={13} />
              还没有文件，先上传 compose.yml、.env 或配置目录。
            </p>
          ) : (
            <ul className="space-y-1" aria-label={`${app.displayName} 的文件`}>
              {app.files.map((file: ContainerAppFile) => {
                const absolute = containerAppFilePath(app, file)
                const rowBusy = writing === appWritingKey(app.slug, file.path)
                const checkingHere = Boolean(checkHere && checkHere.path === file.path && checkHere.loading)
                return (
                  <li
                    key={file.path}
                    className="rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-raised/60"
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span
                        className={`min-w-0 flex-1 truncate font-mono text-xs ${rowBusy ? 'text-fg-subtle' : 'text-fg'}`}
                        title={file.path}
                      >
                        {file.path}
                      </span>
                      {rowBusy ? <span className="text-xs text-fg-subtle">写入中…</span> : null}
                      <span className="shrink-0 text-xs tabular-nums text-fg-muted">{formatSize(file.size)}</span>
                      <span className="shrink-0 text-xs tabular-nums text-fg-subtle">
                        {formatDate(file.modifiedAt)}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <CopyPathButton value={absolute} label="文件真实路径" />
                        {isComposeFile(file.path) ? (
                          <IconButton
                            label="自检引用路径"
                            variant="ghost"
                            onPress={() => void runCheck(gateway, app.slug, file.path)}
                            busy={checkingHere}
                          >
                            <ShieldCheck aria-hidden size={13} />
                          </IconButton>
                        ) : null}
                        <IconButton
                          label={file.text ? '编辑内容' : '二进制文件不支持编辑'}
                          variant="ghost"
                          disabled={!file.text || rowBusy}
                          onPress={() => onEdit(app.slug, file.path)}
                        >
                          <Pencil aria-hidden size={13} />
                        </IconButton>
                        <IconButton
                          label="删除文件"
                          variant="ghost"
                          tone="danger-hover"
                          disabled={rowBusy}
                          onPress={() => setPending({ kind: 'file', path: file.path })}
                        >
                          <Trash2 aria-hidden size={13} />
                        </IconButton>
                      </div>
                    </div>
                    <p className="truncate font-mono text-xs text-fg-subtle" title={absolute}>
                      {absolute}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}

          {checkHere ? (
            <ComposeCheckPanel
              check={checkHere}
              onRerun={() => void runCheck(gateway, app.slug, checkHere.path)}
              onClose={clearCheck}
            />
          ) : null}
        </article>

        <Dialog.Root open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null) }}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
            <Dialog.Content
              aria-describedby="app-delete-description"
              className="fixed left-1/2 top-1/2 z-[61] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl"
            >
              <Dialog.Title className="text-sm font-semibold">
                {pending?.kind === 'app' ? `确认删除工作区「${app.displayName}」？` : '确认删除该文件？'}
              </Dialog.Title>
              <p id="app-delete-description" className="mt-1.5 text-xs text-fg-muted">
                {pending?.kind === 'app'
                  ? '该目录及其中的全部文件都会从磁盘移除，已被容器使用的挂载会失效。此操作不可撤销。'
                  : '文件会从磁盘移除，compose 里指向它的引用会挂不上。此操作不可撤销。'}
              </p>
              <code className="mt-2 block break-all rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 font-mono text-xs text-fg">
                {pending?.kind === 'file'
                  ? containerAppFilePath(app, { path: pending.path })
                  : app.directory}
              </code>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setPending(null)} className={`${CTL_SECONDARY} px-3`}>
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const target = pending
                    setPending(null)
                    if (target?.kind === 'app') void remove(gateway, app.slug)
                    if (target?.kind === 'file') void removeFile(gateway, app.slug, target.path)
                  }}
                  className={`${CTL_DANGER} px-3`}
                >
                  确认删除
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </li>
  )
}
