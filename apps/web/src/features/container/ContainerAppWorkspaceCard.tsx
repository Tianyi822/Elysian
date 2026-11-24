import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { containerAppFilePath, isContainerBuildActive, type ContainerApp, type ContainerBuildTask } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { CTL_CARD_ACTION, CTL_SECONDARY } from '../../components/formControl'
import { formatDateTime } from '../../components/format'
import { IconButton } from '../../components/IconButton'
import { ChevronDown, ChevronRight, Folder, Hammer, Trash2, TriangleAlert, Upload } from '../../components/icons'
import { LoadingOrb } from '../../components/LoadingOrb'
import { RefreshButton } from '../../components/RefreshState'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'
import { useSilentPolling } from '../../components/useSilentPolling'
import { appWritingKey, newBuildRequestId, useContainerAppsStore, WORKSPACE_WRITING_PATH } from '../../stores/containerAppsStore'
import { BuildTaskList, buildTargetsLabel } from './BuildTaskList'
import { ComposeCheckPanel } from './ComposeCheckPanel'
import { ContainerBuildDialog } from './ContainerBuildDialog'
import { ContainerBuildLogsSheet } from './ContainerBuildLogsSheet'
import { CopyPathButton } from './CopyPathButton'
import { WorkspaceFileList } from './WorkspaceFileList'

/** 待确认的删除目标：工作区连目录一起删，单文件只删自己。 */
type Pending = { kind: 'app' } | { kind: 'file'; path: string } | null

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
  const buildList = useContainerAppsStore((s) => s.buildsBySlug[app.slug])
  const builds = buildList?.tasks ?? []
  const buildsRefreshing = buildList?.refreshing ?? false
  const buildsErrorMessage = buildList?.errorMessage
  useFeedbackMessage(buildsErrorMessage)
  const loadBuilds = useContainerAppsStore((s) => s.loadBuilds)
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

  // 任务区首次展开才加载；之后收起再展开静默更新，不闪加载态。
  useEffect(() => {
    if (buildsOpen) void loadBuilds(gateway, app.slug, { silent: true })
  }, [buildsOpen, gateway, app.slug, loadBuilds])

  const hasActiveBuild = builds.some((task) => isContainerBuildActive(task.state))
  const buildListScope = useMemo(() => [gateway, app.slug, buildsOpen, hasActiveBuild, logsTaskId], [gateway, app.slug, buildsOpen, hasActiveBuild, logsTaskId])
  useSilentPolling(() => loadBuilds(gateway, app.slug, { silent: true }), {
    intervalMs: 2000, enabled: buildsOpen || hasActiveBuild || logsTaskId !== null, pauseOnHidden: false, scope: buildListScope,
  })

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
    <li id={`workspace-${app.slug}`} aria-label={`工作区 ${app.displayName}`} className="h-full">
      <div className="relative rounded-xl h-full" aria-busy={batchBusy}>
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
              <Button variant="outline" type="button" onClick={() => setBuildDialogOpen(true)} className={CTL_CARD_ACTION}>
                <Hammer aria-hidden size={13} />
                构建镜像
              </Button>
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
          <WorkspaceFileList
            app={app}
            writing={writing}
            checkingPath={checkHere?.status === 'loading' ? checkHere.path : undefined}
            onCheck={(path) => void runCheck(gateway, app.slug, path)}
            onEdit={(path) => onEdit(app.slug, path)}
            onRemove={(path) => setPending({ kind: 'file', path })}
          />

          {checkHere ? (
            <ComposeCheckPanel
              check={checkHere}
              onRerun={() => void runCheck(gateway, app.slug, checkHere.path)}
              onClose={clearCheck}
            />
          ) : null}

          {/* 构建任务区：折叠入口常驻，刷新只更新本区任务。 */}
          <section aria-label={`${app.displayName} 的构建任务`} className="rounded-lg border border-line bg-surface px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <Button variant="outline"
                type="button"
                onClick={() => setBuildsOpen((open) => !open)}
                aria-expanded={buildsOpen}
                className={`${CTL_CARD_ACTION}`}
              >
                {buildsOpen ? <ChevronDown aria-hidden size={13} /> : <ChevronRight aria-hidden size={13} />}
                构建任务{builds.length > 0 ? `（${builds.length}）` : ''}
              </Button>
              {buildsOpen ? (
                <RefreshButton
                  onPress={() => void loadBuilds(gateway, app.slug)}
                  busy={buildsRefreshing}
                  label="刷新构建任务"
                />
              ) : null}
            </div>
            {buildsOpen ? (
              <div className="relative rounded-xl mt-2 border-t border-line pt-2" aria-busy={buildsRefreshing}>
                {buildsErrorMessage ? (
                  <div role="alert" className="flex flex-wrap items-center gap-2 py-2 text-xs text-danger">
                    <TriangleAlert aria-hidden size={13} className="shrink-0" />
                    <span className="min-w-0 flex-1">{buildsErrorMessage}</span>
                    <Button variant="outline"
                      type="button"
                      onClick={() => void loadBuilds(gateway, app.slug)}
                      className={`${CTL_SECONDARY} px-2`}
                    >
                      重试
                    </Button>
                  </div>
                ) : buildList?.status === 'loading' ? (
                  <p role="status" className="flex items-center justify-center gap-2 py-4 text-xs text-fg-muted">
                    <LoadingOrb size={13} />
                    正在读取构建任务…
                  </p>
                ) : builds.length === 0 ? (
                  <p className="py-3 text-center text-xs text-fg-subtle">
                    还没有构建任务，点上方「构建镜像」从 Dockerfile 或 compose 服务开始。
                  </p>
                ) : (
                  <BuildTaskList
                    workspaceName={app.displayName}
                    tasks={builds}
                    onLogs={setLogsTaskId}
                    onCancel={setCancelTarget}
                    onRebuild={rebuild}
                  />
                )}
              </div>
            ) : null}
          </section>
        </article>
        <ConfirmDialog
          open={pending !== null}
          title={pending?.kind === 'app' ? `确认删除工作区「${app.displayName}」？` : '确认删除该文件？'}
          surface={{ 'aria-describedby': 'app-delete-description', className: 'w-[min(30rem,calc(100vw-2rem))] p-4 shadow-xl' }}
          description={
            <p id="app-delete-description" className="mt-1.5 text-xs text-fg-muted">
              {pending?.kind === 'app'
                ? '该目录及其中的全部文件都会从磁盘移除，已被容器使用的挂载会失效。此操作不可撤销。'
                : '文件会从磁盘移除，compose 里指向它的引用会挂不上。此操作不可撤销。'}
            </p>
          }
          danger confirmLabel="确认删除" cancelClassName="px-3" confirmClassName="px-3"
          onClose={() => setPending(null)}
          onConfirm={() => {
            const target = pending
            setPending(null)
            if (target?.kind === 'app') void remove(gateway, app.slug)
            if (target?.kind === 'file') void removeFile(gateway, app.slug, target.path)
          }}
        >
          <code className="mt-2 block break-all rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 font-mono text-xs text-fg">
            {pending?.kind === 'file' ? containerAppFilePath(app, { path: pending.path }) : app.directory}
          </code>
        </ConfirmDialog>
        <ConfirmDialog
          open={cancelTarget !== null}
          title={`取消构建任务 ${cancelTarget ? buildTargetsLabel(cancelTarget) : ''}？`}
          surface={{ 'aria-describedby': 'cancel-build-description', className: 'w-[min(28rem,calc(100vw-2rem))] p-4 shadow-xl' }}
          description={
            <p id="cancel-build-description" className="mt-1.5 text-xs text-fg-muted">
              已完成的镜像会保留。取消后如需再次构建，用「重新构建」发起一个新任务。
            </p>
          }
          danger confirmLabel="确认取消" cancelLabel="继续构建" cancelClassName="px-3" confirmClassName="px-3"
          onClose={() => setCancelTarget(null)}
          onConfirm={() => {
            const target = cancelTarget
            setCancelTarget(null)
            if (target) void cancelBuild(gateway, app.slug, target.id)
          }}
        />
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
