import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Copy,
  File as FileIcon,
  Folder,
  Hammer,
  Loader2,
  Pencil,
  RotateCw,
  ScrollText,
  ShieldCheck,
  Square,
  Timer,
  Trash2,
  TriangleAlert,
  Upload,
} from '../../components/icons'
import { containerAppFilePath, CONTAINER_BUILD_STATE_LABELS, isContainerBuildActive } from '@elysian/contracts'
import type { ContainerApp, ContainerAppFile, ContainerBuildTask } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useClipboardCopy } from '../../components/CopyButton'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { IconButton } from '../../components/IconButton'
import { CTL_CARD_ACTION, CTL_DANGER, CTL_SECONDARY } from '../../components/formControl'
import { formatDateTime } from '../../components/format'
import {
  appWritingKey,
  isComposeFile,
  newBuildRequestId,
  useContainerAppsStore,
  WORKSPACE_WRITING_PATH,
} from '../../stores/containerAppsStore'
import { ComposeCheckPanel } from './ComposeCheckPanel'
import { ContainerBuildDialog } from './ContainerBuildDialog'
import { ContainerBuildLogsSheet } from './ContainerBuildLogsSheet'
import { formatWorkspaceSize } from './formatWorkspaceSize'

/** 待确认的删除目标：工作区连目录一起删，单文件只删自己。 */
type Pending = { kind: 'app' } | { kind: 'file'; path: string } | null

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

/** 状态一律「文字 + 颜色 + 图标」：颜色只作辅助，语义由文字承担。 */
function BuildStateBadge({ state }: { state: ContainerBuildTask['state'] }) {
  const label = CONTAINER_BUILD_STATE_LABELS[state]
  if (state === 'queued') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
        <Timer aria-hidden size={12} />
        {label}
      </span>
    )
  }
  if (state === 'building') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
        <Loader2 aria-hidden size={12} className="animate-spin motion-reduce:animate-none" />
        {label}
      </span>
    )
  }
  if (state === 'succeeded') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-success">
        <CircleCheck aria-hidden size={12} />
        {label}
      </span>
    )
  }
  if (state === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-danger">
        <TriangleAlert aria-hidden size={12} />
        {label}
      </span>
    )
  }
  if (state === 'cancelled') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-fg-subtle">
        <Square aria-hidden size={12} />
        {label}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-warning">
      <TriangleAlert aria-hidden size={12} />
      {label}
    </span>
  )
}

/** 任务行的目标摘要：dockerfile 用目标名，compose 用提交的服务清单（缺省全部 build 服务）。 */
function buildTargetsLabel(task: ContainerBuildTask): string {
  if (task.mode === 'dockerfile') return task.input.mode === 'dockerfile' ? task.input.target ?? 'app' : 'app'
  return task.input.mode === 'compose' && task.input.services?.length ? task.input.services.join('、') : '全部 build 服务'
}

/**
 * 单个工作区卡片。
 *
 * 卡片把真实绝对路径摆在最显眼的位置：上传这些文件的意义就在于「compose 里能写到它」，
 * 所以目录一行、每个文件一行都给完整路径与复制入口，自检结果里也是同一个形状。
 * 卡片下方是可折叠的构建任务区（ADR-0021）：状态轮询、日志与取消都从这里出发。
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
  const builds = useContainerAppsStore((s) => s.buildsBySlug[app.slug]) ?? []
  const buildsLoading = useContainerAppsStore((s) => s.buildsLoading[app.slug]) === true
  const buildsRefreshing = useContainerAppsStore((s) => s.buildsRefreshing[app.slug]) === true
  const buildsError = useContainerAppsStore((s) => s.buildsError[app.slug]) ?? null
  const ensureBuilds = useContainerAppsStore((s) => s.ensureBuilds)
  const refreshBuilds = useContainerAppsStore((s) => s.refreshBuilds)
  const submitBuild = useContainerAppsStore((s) => s.submitBuild)
  const cancelBuild = useContainerAppsStore((s) => s.cancelBuild)

  const [pending, setPending] = useState<Pending>(null)
  const [buildDialogOpen, setBuildDialogOpen] = useState(false)
  const [buildsOpen, setBuildsOpen] = useState(false)
  const [logsTaskId, setLogsTaskId] = useState<string | null>(null)
  const [cancelTarget, setCancelTarget] = useState<ContainerBuildTask | null>(null)

  const directoryInputRef = useRef<HTMLInputElement>(null)
  // webkitdirectory 不在 React 的类型里，只能在节点上直接设属性。
  useEffect(() => {
    directoryInputRef.current?.setAttribute('webkitdirectory', '')
  }, [])

  // 任务区首次展开才加载；之后收起再展开走刷新遮罩，不闪加载态。
  useEffect(() => {
    if (buildsOpen) void ensureBuilds(gateway, app.slug)
  }, [buildsOpen, gateway, app.slug, ensureBuilds])

  const hasActiveBuild = builds.some((task) => isContainerBuildActive(task.state))
  // 静默轮询（对齐 WebsitesPanel 先例）：任一活跃任务、任务区展开或日志抽屉打开时 2s 一拍；
  // 轮询不驱动 BusyVeil 与 RefreshButton，手动刷新才转图标。
  useEffect(() => {
    if (!buildsOpen && !hasActiveBuild && logsTaskId === null) return
    const timer = window.setInterval(() => void refreshBuilds(gateway, app.slug, { silent: true }), 2000)
    return () => window.clearInterval(timer)
  }, [gateway, app.slug, buildsOpen, hasActiveBuild, logsTaskId, refreshBuilds])

  const batchBusy = writing === appWritingKey(app.slug, WORKSPACE_WRITING_PATH)
  const checkHere = check?.slug === app.slug ? check : null

  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    // 清空 value：连续选同一份文件也要能再次触发 change。
    event.target.value = ''
    if (files.length > 0) void upload(gateway, app.slug, files)
  }

  const rebuild = (task: ContainerBuildTask) => {
    // 原参数重新提交，唯一换新 requestId：重试永远产生新任务，不复用旧任务的幂等键。
    void submitBuild(gateway, app.slug, { ...task.input, requestId: newBuildRequestId() }, { notifyOnError: true })
  }

  return (
    <li aria-label={`工作区 ${app.displayName}`} className="h-full">
      <div className="busy-host h-full">
        <BusyVeil busy={batchBusy} />
        <article className="flex h-full flex-col gap-3 panel-surface px-4 py-3.5">
          <header className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 max-w-full">
              <h3 className="break-words text-sm font-medium">{app.displayName}</h3>
              <p className="mt-0.5 break-all font-mono text-xs text-fg-subtle">
                {app.slug} · {formatDateTime(app.createdAt)} 建
              </p>
            </div>
            <div className="flex max-w-full flex-wrap items-center gap-2">
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
              <button type="button" onClick={() => setBuildDialogOpen(true)} className={CTL_CARD_ACTION}>
                <Hammer aria-hidden size={13} />
                构建镜像
              </button>
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
              compose 里 <span className="font-mono">./</span> 开头的引用以 compose 文件所在目录为根；挂载时也可使用下方文件的绝对路径。
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
                    className="rounded-lg px-2 py-2 transition-colors hover:bg-surface-raised/60"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className={`break-all font-mono text-xs ${rowBusy ? 'text-fg-subtle' : 'text-fg'}`}>
                          {file.path}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-fg-subtle">
                          {rowBusy ? <span>写入中…</span> : null}
                          <span>{formatWorkspaceSize(file.size)}</span>
                          <span>{formatDateTime(file.modifiedAt)}</span>
                        </div>
                      </div>
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
                    <p className="mt-1.5 break-all font-mono text-xs leading-relaxed text-fg-subtle">
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

          {/* 构建任务区：折叠入口常驻；工具栏（折叠与刷新按钮）在遮罩外。 */}
          <section aria-label={`${app.displayName} 的构建任务`} className="rounded-lg border border-line bg-surface px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setBuildsOpen((open) => !open)}
                aria-expanded={buildsOpen}
                className={`${CTL_CARD_ACTION}`}
              >
                {buildsOpen ? <ChevronDown aria-hidden size={13} /> : <ChevronRight aria-hidden size={13} />}
                构建任务{builds.length > 0 ? `（${builds.length}）` : ''}
              </button>
              {buildsOpen ? (
                <RefreshButton
                  onPress={() => void refreshBuilds(gateway, app.slug)}
                  busy={buildsRefreshing}
                  label="刷新构建任务"
                  variant="ghost"
                />
              ) : null}
            </div>

            {buildsOpen ? (
              <div className="busy-host relative mt-2 border-t border-line pt-2">
                <BusyVeil busy={buildsRefreshing} />
                {buildsError ? (
                  <div role="alert" className="flex flex-wrap items-center gap-2 py-2 text-xs text-danger">
                    <TriangleAlert aria-hidden size={13} className="shrink-0" />
                    <span className="min-w-0 flex-1">{buildsError}</span>
                    <button
                      type="button"
                      onClick={() => void refreshBuilds(gateway, app.slug)}
                      className={`${CTL_SECONDARY} px-2`}
                    >
                      重试
                    </button>
                  </div>
                ) : buildsLoading && builds.length === 0 ? (
                  <p role="status" className="flex items-center justify-center gap-2 py-4 text-xs text-fg-muted">
                    <Loader2 aria-hidden size={13} className="animate-spin" />
                    正在读取构建任务…
                  </p>
                ) : builds.length === 0 ? (
                  <p className="py-3 text-center text-xs text-fg-subtle">
                    还没有构建任务，点上方「构建镜像」从 Dockerfile 或 compose 服务开始。
                  </p>
                ) : (
                  <ul className="space-y-2" aria-label={`${app.displayName} 的构建任务列表`}>
                    {builds.map((task) => {
                      const active = isContainerBuildActive(task.state)
                      return (
                        <li key={task.id} className="rounded-lg border border-line bg-surface-raised/50 px-2.5 py-2">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="min-w-0 flex-1 truncate text-xs text-fg">
                              <span className="font-mono">{buildTargetsLabel(task)}</span>
                              <span className="ml-1.5 text-fg-subtle">
                                {task.mode === 'dockerfile' ? 'Dockerfile' : 'compose'}
                              </span>
                            </span>
                            <BuildStateBadge state={task.state} />
                            <span className="shrink-0 text-xs tabular-nums text-fg-subtle" title={`提交于 ${task.createdAt}`}>
                              {formatDateTime(task.createdAt)}
                            </span>
                            <div className="flex shrink-0 items-center gap-1">
                              <IconButton
                                label="查看构建日志"
                                variant="ghost"
                                onPress={() => setLogsTaskId(task.id)}
                              >
                                <ScrollText aria-hidden size={13} />
                              </IconButton>
                              {active ? (
                                <button
                                  type="button"
                                  onClick={() => setCancelTarget(task)}
                                  className={`${CTL_DANGER} px-2 text-xs`}
                                >
                                  取消
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => rebuild(task)}
                                  className={`${CTL_SECONDARY} gap-1 px-2 text-xs`}
                                >
                                  <RotateCw aria-hidden size={12} />
                                  重新构建
                                </button>
                              )}
                            </div>
                          </div>
                          <p className="mt-1 text-xs text-fg-muted">{task.stage}</p>
                          {task.state === 'failed' && task.error ? (
                            <p role="alert" className="mt-1 break-all text-xs text-danger">
                              {task.error}
                            </p>
                          ) : null}
                          {task.state === 'succeeded' && task.results.length > 0 ? (
                            <p className="mt-1 text-xs text-fg-subtle">
                              面板不编排，请在宿主自行拉起（compose up 或 docker run）。
                            </p>
                          ) : null}
                          {task.results.length > 0 ? (
                            <ul className="mt-1.5 space-y-1">
                              {task.results.map((result) => (
                                <li key={`${result.target}:${result.tag}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                  {result.state === 'succeeded' ? (
                                    <>
                                      <code className="min-w-0 flex-1 break-all font-mono text-xs text-fg">
                                        {result.repository}:{result.tag}
                                      </code>
                                      <span className="shrink-0 text-xs text-fg-subtle">{result.target}</span>
                                      <CopyPathButton
                                        value={`${result.repository}:${result.tag}`}
                                        label="完整镜像标签"
                                      />
                                    </>
                                  ) : (
                                    <p className="min-w-0 flex-1 break-all text-xs text-danger">
                                      {result.target}：{result.error}
                                    </p>
                                  )}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            ) : null}
          </section>
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

        <Dialog.Root
          open={cancelTarget !== null}
          onOpenChange={(open) => { if (!open) setCancelTarget(null) }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
            <Dialog.Content
              aria-describedby="cancel-build-description"
              className="fixed left-1/2 top-1/2 z-[61] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl"
            >
              <Dialog.Title className="text-sm font-semibold">
                取消构建任务 {cancelTarget ? buildTargetsLabel(cancelTarget) : ''}？
              </Dialog.Title>
              <p id="cancel-build-description" className="mt-1.5 text-xs text-fg-muted">
                已完成的镜像会保留。取消后如需再次构建，用「重新构建」发起一个新任务。
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setCancelTarget(null)} className={`${CTL_SECONDARY} px-3`}>
                  继续构建
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const target = cancelTarget
                    setCancelTarget(null)
                    if (target) void cancelBuild(gateway, app.slug, target.id)
                  }}
                  className={`${CTL_DANGER} px-3`}
                >
                  确认取消
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        {buildDialogOpen ? (
          <ContainerBuildDialog app={app} onClose={() => setBuildDialogOpen(false)} />
        ) : null}
        {logsTaskId ? (
          <ContainerBuildLogsSheet
            slug={app.slug}
            taskId={logsTaskId}
            onClose={() => setLogsTaskId(null)}
          />
        ) : null}
      </div>
    </li>
  )
}
