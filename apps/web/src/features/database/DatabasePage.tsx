import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import {
  Cable,
  ChevronRight,
  Check,
  Container,
  Database,
  Download,
  KeyRound,
  MariaDBLogo,
  MemoryStick,
  MySQLLogo,
  File,
  Timer,
  Trash2,
} from '../../components/icons'
import type { DatabasePortMapping } from '@elysian/contracts'
import { useClipboardCopy } from '../../components/CopyButton'
import { CTL_PRIMARY, CTL_TOOLBAR } from '../../components/formControl'
import { ErrorState, EmptyState, LoadingState } from '../../components/states/StateViews'
import { StaleDataBanner } from '../../components/states/StaleDataBanner'
import { RefreshButton } from '../../components/RefreshState'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { useGateway } from '../../adapters/GatewayProvider'
import { DATABASE_CONTAINER_STATUS_LABELS, DATABASE_STATUS_LABELS } from '@elysian/contracts'
import type {
  DatabaseContainerInstance,
  DatabaseContainerStatus,
  DatabaseEngine,
  DatabaseInstance,
  DatabaseStatus,
} from '@elysian/contracts'
import { useDatabaseStore } from '../../stores/databaseStore'
import { useContainersStore } from '../../stores/containersStore'
import { useDependencyProbeStore } from '../../stores/dependencyProbeStore'
import { formatDateTime } from '../../components/format'
import { projectDatabaseCard } from './projectDatabaseCard'
import type { DatabaseCardView } from './projectDatabaseCard'
import { DatabaseCreateDialog } from './DatabaseCreateDialog'
import { ContainerDetailSheet } from '../../components/ContainerDetailSheet'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'
import { useMessageStore } from '../../stores/messageStore'
import { Button } from '../../components/Button'
import { messageOf } from '../../utils/errorMessage'

const CONTAINER_STATUS_TONE: Record<DatabaseContainerStatus, StatusTone> = {
  running: 'success',
  stopped: 'danger',
  missing: 'warning',
}

const FILE_STATUS_TONE: Record<DatabaseStatus, StatusTone> = {
  running: 'success',
  warning: 'warning',
  stopped: 'danger',
}

/** 数据库页：上部是按数据库镜像筛选的容器管理分区，下部是常驻的 SQLite 文件分区。 */
export function DatabasePage() {
  const gateway = useGateway()
  const status = useDatabaseStore((state) => state.status)
  const engine = useDatabaseStore((state) => state.engine)
  const databases = useDatabaseStore((state) => state.databases)
  const sqliteFiles = useDatabaseStore((state) => state.sqliteFiles)
  const containers = useContainersStore((state) => state.containers)
  const openContainerDetail = useContainersStore((state) => state.openDetail)
  const errorMessage = useDatabaseStore((state) => state.errorMessage)
  const refreshing = useDatabaseStore((state) => state.refreshing)
  const load = useDatabaseStore((state) => state.load)
  const refresh = useDatabaseStore((state) => state.refresh)
  const openCreate = useDatabaseStore((state) => state.openCreate)
  const removingContainerIds = useDatabaseStore((state) => state.removingContainerIds)
  const removingSqliteIds = useDatabaseStore((state) => state.removingSqliteIds)
  const removeContainer = useDatabaseStore((state) => state.removeContainer)
  const removeSqliteFile = useDatabaseStore((state) => state.removeSqliteFile)
  const check = useDependencyProbeStore((state) => state.check)

  useEffect(() => {
    void load(gateway)
    // 依赖检测幂等：切页重挂不重探，报告由探测层消费。
    void check(gateway)
  }, [gateway, load, check])
  // 15 秒静默轮询：ADR-0058 局部刷新，只更新列表区域，不叠加遮罩。
  useEffect(() => {
    const timer = window.setInterval(() => { void refresh(gateway) }, 15_000)
    return () => window.clearInterval(timer)
  }, [gateway, refresh])

  const containerById = useMemo(
    () => new Map(containers.map((container) => [container.id, container])),
    [containers],
  )

  const filtered = databases.filter((row) => row.engine === engine)

  return (
    <>
      <section aria-label="数据库实例" className="mb-6">
        {status === 'ready' && errorMessage ? <StaleDataBanner className="mb-3" error={errorMessage} onRetry={() => void refresh(gateway, true)} /> : null}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{engine} 数据库容器</h2>
          <div className={`${CTL_TOOLBAR} flex flex-wrap items-center gap-2`}>
            <RefreshButton onPress={() => void refresh(gateway, true)} busy={refreshing} />
            <Button variant="primary" type="button" disabled={status !== 'ready'} onClick={() => openCreate('container')} className={CTL_PRIMARY}>
              添加数据库
            </Button>
          </div>
        </div>
        {status === 'error' ? (
          <ErrorState title="数据库数据加载失败" description={errorMessage} onRetry={() => void load(gateway)} />
        ) : status !== 'ready' ? (
          <LoadingState label="正在加载数据库数据…" />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={`没有 ${engine} 数据库容器`}
            description="拉取镜像并创建新容器；本机已有数据库镜像的容器会自动出现在这里。"
          />
        ) : (
          /* 列数量内容区的实测宽度（容器查询）而非视口：侧边栏收展改变可用宽度，卡片随之增减，不会出现「空间变大卡片反而变小」的倒挂。 */
          <div className="@container">
            <ul
              aria-label={`${engine} 数据库容器列表`}
              className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-4"
            >
              {filtered.map((row) => (
                <li key={row.id} className="h-full">
                  <DatabaseContainerCard
                    row={row}
                    view={projectDatabaseCard(row, containerById)}
                    removing={removingContainerIds.includes(row.id)}
                    refreshing={refreshing}
                    onJump={() => openContainerDetail(row.containerId)}
                    onRemove={() => void removeContainer(gateway, row.id)}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <SqliteFilesSection
        files={sqliteFiles}
        removingIds={removingSqliteIds}
        onOpenCreate={() => openCreate('file')}
        onRemove={(fileId) => void removeSqliteFile(gateway, fileId)}
      />
      <DatabaseCreateDialog />
      <ContainerDetailSheet />
    </>
  )
}

/** SQLite 文件分区：与容器视图分开的固定分区，不占引擎页签。 */
function SqliteFilesSection({
  files,
  removingIds,
  onOpenCreate,
  onRemove,
}: {
  files: readonly DatabaseInstance[]
  removingIds: readonly string[]
  onOpenCreate(): void
  onRemove(fileId: string): void
}) {
  const gateway = useGateway()
  const status = useDatabaseStore((state) => state.sqliteStatus)
  const errorMessage = useDatabaseStore((state) => state.sqliteErrorMessage)
  const load = useDatabaseStore((state) => state.load)
  return (
    <section aria-label="SQLite 文件" className="mb-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">SQLite 文件</h2>
        <Button variant="primary" type="button" disabled={status !== 'ready'} onClick={onOpenCreate} className={CTL_PRIMARY}>
          添加 SQLite 文件
        </Button>
      </div>
      {status === 'ready' && errorMessage ? (
        <p role="alert" className="mb-3 text-xs text-danger">
          SQLite 文件刷新失败，已保留上次读取结果。{errorMessage}
          <Button variant="link" type="button" className="ml-2 underline" onClick={() => void load(gateway)}>重试</Button>
        </p>
      ) : null}
      {status === 'error' ? (
        <ErrorState title="SQLite 文件加载失败" description={errorMessage} onRetry={() => void load(gateway)} />
      ) : status !== 'ready' ? (
        <LoadingState label="正在加载 SQLite 文件…" />
      ) : files.length === 0 ? (
        <EmptyState
          title="没有 SQLite 文件"
          description="新建空库或上传独立 SQLite 快照；文件管理与数据库容器分开。"
        />
      ) : (
        <div className="@container">
          <ul
            aria-label="SQLite 文件列表"
            className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-4"
          >
            {files.map((file) => (
              <li key={file.id} className="h-full">
                <SqliteFileCard
                  file={file}
                  removing={removingIds.includes(file.id)}
                  onRemove={() => onRemove(file.id)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** 数据库容器卡：连接地址、端口、网络、卷、凭据状态与容器内存全部来自 Docker 事实。 */
function DatabaseContainerCard({
  row,
  view,
  removing,
  refreshing = false,
  onJump,
  onRemove,
}: {
  row: DatabaseContainerInstance
  view: DatabaseCardView
  removing: boolean
  /** 列表刷新在途：保留卡片内容并标记可访问的忙碌状态。 */
  refreshing?: boolean
  onJump(): void
  onRemove(): void
}) {
  const gateway = useGateway()
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [actionError, setActionError] = useState('')
  const [powerBusy, setPowerBusy] = useState(false)
  useFeedbackMessage(actionError)
  const { copy: copyCredential } = useClipboardCopy()

  const performAction = async (action: () => Promise<unknown>, message: string) => {
    setActionError('')
    try {
      await action()
      useMessageStore.getState().notify({ tone: 'success', message })
      await useDatabaseStore.getState().refreshAfterMutation(gateway, 'container')
    } catch (error) {
      setActionError(messageOf(error, '数据库操作失败'))
    }
  }

  const revealAndCopy = async (field: 'username' | 'password') => {
    try {
      const secret = await gateway.databases.reveal(row.id)
      await copyCredential(secret[field], field === 'username' ? '管理员用户名' : '管理员密码')
      setActionError('')
    } catch (error) { setActionError(messageOf(error, '读取管理员凭据失败')) }
  }

  const powerAction: 'start' | 'stop' = row.status === 'running' ? 'stop' : 'start'
  const togglePower = async () => {
    setActionError('')
    setPowerBusy(true)
    try {
      await gateway.containers.requestAction(row.containerId, powerAction)
      useMessageStore.getState().notify({ tone: 'success', message: powerAction === 'stop' ? `已停止容器 ${row.name}` : `已启动容器 ${row.name}` })
      await useDatabaseStore.getState().refreshAfterMutation(gateway, 'container')
    } catch (error) {
      setActionError(messageOf(error, '容器操作失败'))
    } finally {
      setPowerBusy(false)
    }
  }

  const address = row.address ? `${row.address.host}:${row.address.port}` : undefined
  const missing = row.status === 'missing'
  const hasManagedVolume = row.source === 'managed' && Boolean(row.volumeName)
  const removeLabel = missing ? (hasManagedVolume ? '删除专属卷及登记' : '清理登记') : '删除容器及数据'

  return (
    <article
      aria-label={`${row.engine} 数据库容器 ${row.name}`}
      aria-busy={refreshing}
      className="@container flex h-full flex-col gap-3 panel-surface p-4 md:p-5"
    >
      {/* 头部是两行网格：图标跨两行；第一行容器名对状态标签，第二行版本对更新时间——左右同行同基线。 */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
        <div className="row-span-2 flex items-center">
          <DatabaseMark engine={row.engine} />
        </div>
        <h3 className="truncate text-sm font-semibold">{row.name}</h3>
        <StatusTag label={DATABASE_CONTAINER_STATUS_LABELS[row.status]} tone={CONTAINER_STATUS_TONE[row.status]} />
        <p className="truncate text-xs text-fg-muted">
          {row.engine} · {row.version}
        </p>
        <time dateTime={row.updatedAt} className="whitespace-nowrap text-xs text-fg-subtle">
          更新于 {formatDateTime(row.updatedAt)}
        </time>
      </div>
      {missing ? (
        <p className="text-xs text-warning">
          {hasManagedVolume ? `可清理残留的专属卷 ${row.volumeName} 及登记。` : '容器已从 Docker 移除，可清理面板登记。'}
        </p>
      ) : (
        <>
          {/* 镜像行：完整引用取行自带的 Docker 事实；点击就地打开容器详情（端口与卷详情的载体）。 */}
          <Button unstyled
            type="button"
            onClick={onJump}
            disabled={view.kind !== 'container' || view.missingContainer}
            title={view.kind === 'container' && !view.missingContainer ? `打开容器 ${row.name} 的详情` : '容器详情不可用'}
            className="flex w-full items-center gap-2 rounded-lg bg-surface-raised px-3 py-2 text-left text-xs text-fg-muted transition-colors hover:bg-surface-raised/70 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Container aria-hidden size={14} className="shrink-0 text-fg-subtle" />
            <span className="hidden shrink-0 @sm:inline">镜像</span>
            {view.kind === 'container' && view.missingContainer ? (
              <span className="min-w-0 flex-1 truncate text-fg-subtle">容器详情不可用</span>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate font-mono text-fg" title={view.kind === 'container' ? view.imageLabel : undefined}>
                  {view.kind === 'container' ? view.imageLabel : ''}
                </span>
                <ChevronRight aria-hidden size={14} className="shrink-0 text-fg-subtle" />
              </>
            )}
          </Button>

          {/* 指标格随卡片实际宽度分栏：三列布局下卡片窄、指标竖排，宽卡才三格横排（容器查询而非视口断点）。 */}
          <div className="grid grid-cols-1 gap-2.5 @lg:grid-cols-3">
            <FileStat icon={<Cable aria-hidden size={14} />} label="连接地址" value={address ?? '不可用'} />
            <FileStat icon={<MemoryStick aria-hidden size={14} />} label="容器内存" value={row.memory ? `${(row.memory.usedGb * 1024).toFixed(1)} MB` : '不可用'} />
            <FileStat
              icon={<KeyRound aria-hidden size={14} />}
              label="管理员凭据"
              value={row.credentialsVerified ? row.credentialUsername || '已核验' : '未核验'}
            />
          </div>
          {/* 端口、网络与卷直接取 Docker inspect 事实；每行单值截断，完整内容放 title。 */}
          <dl className="space-y-1 text-xs">
            <div className="flex min-w-0 gap-2">
              <dt className="shrink-0 text-fg-subtle">端口</dt>
              <dd className="min-w-0 flex-1 truncate font-mono text-fg" title={formatPorts(row.ports)}>
                {formatPorts(row.ports)}
              </dd>
            </div>
            <div className="flex min-w-0 gap-2">
              <dt className="shrink-0 text-fg-subtle">网络</dt>
              <dd className="min-w-0 flex-1 truncate text-fg" title={row.networks.join('、')}>
                {row.networks.join('、') || '—'}
              </dd>
            </div>
            <div className="flex min-w-0 gap-2">
              <dt className="shrink-0 text-fg-subtle">卷</dt>
              <dd className="min-w-0 flex-1 truncate font-mono text-fg" title={row.volumeName ?? ''}>
                {row.volumeName ?? '未挂载专属卷'}
              </dd>
            </div>
          </dl>
          {row.needsAttention ? <div className="rounded-lg border border-warning/40 p-2 text-xs text-warning"><p>容器尚未核对完成。修复容器后可重新核对；不再使用时可删除容器及数据。</p><div className="mt-2 flex gap-2"><Button variant="outline" type="button" onClick={() => void performAction(() => gateway.databases.reconcile(row.id), `数据库容器 ${row.name} 已重新核对`)} className="rounded border border-line px-2 py-1">重新核对</Button></div></div> : null}
        </>
      )}

      {/* 动作行沉底：卡片因同列内容高度不齐被拉伸时，操作区贴住卡底。 */}
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {/* 管理员凭据只在用户点击复制时经 reveal 端点按需读取；未登记容器标「未核验」，不摆复制按钮。 */}
        {row.credentialsVerified ? (
          <>
            <Button variant="outline" type="button" onClick={() => void revealAndCopy('username')} title="从服务端读取并复制管理员用户名" className="rounded border border-line px-2 py-1 text-xs">复制用户名</Button>
            <Button variant="outline" type="button" onClick={() => void revealAndCopy('password')} title="从服务端读取并复制管理员密码" className="rounded border border-line px-2 py-1 text-xs">复制密码</Button>
          </>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {!missing ? <Button variant="outline"
            type="button"
            onClick={() => void togglePower()}
            disabled={powerBusy || removing}
            className="action-button shrink-0 gap-1.5 border border-control-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          >
            {powerAction === 'stop' ? '停止' : '启动'}
          </Button> : null}
          {missing || hasManagedVolume ? <Button variant="destructive" type="button" onClick={() => setConfirmRemove(true)} disabled={removing} className="rounded-lg border border-danger/40 px-2 py-1.5 text-xs text-danger">{removeLabel}</Button> : null}
        </div>
      </div>
      {confirmRemove ? (
        <ConfirmDialog
          title={missing ? `${removeLabel}？` : '删除容器及全部数据？'}
          description={
            <p className="mt-2 text-xs text-danger">
              {missing ? (hasManagedVolume ? `将删除 ${row.name} 的残留专属卷及面板登记。卷内数据无法恢复。` : `将清理 ${row.name} 的面板登记。`) : `将删除数据库容器 ${row.name} 及其专属持久卷，全部数据无法恢复。此操作无法撤销。`}
            </p>
          }
          danger confirmLabel={`确认${removeLabel}`}
          cancelClassName="rounded border border-line px-3 py-1.5 text-xs"
          confirmClassName="rounded border border-danger px-3 py-1.5 text-xs text-danger"
          onClose={() => setConfirmRemove(false)}
          onConfirm={() => { setConfirmRemove(false); onRemove() }}
        />
      ) : null}
    </article>
  )
}

/** SQLite 文件卡：就是一个本地文件，没有容器、没有账号、没有连接入口。 */
function SqliteFileCard({
  file,
  removing,
  onRemove,
}: {
  file: DatabaseInstance
  removing: boolean
  onRemove(): void
}) {
  const gateway = useGateway()
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [actionError, setActionError] = useState('')
  useFeedbackMessage(actionError)
  const { copied: pathCopied, copy: copyFilePath } = useClipboardCopy()

  const performAction = async (action: () => Promise<unknown>, message: string, changed = false) => {
    setActionError('')
    try {
      await action()
      useMessageStore.getState().notify({ tone: 'success', message })
      if (changed) await useDatabaseStore.getState().refreshAfterMutation(gateway, 'file')
    } catch (error) {
      setActionError(messageOf(error, '数据库操作失败'))
    }
  }

  return (
    <article
      aria-label={`SQLite 数据库 ${file.name}`}
      className="@container flex h-full flex-col gap-3 panel-surface p-4 md:p-5"
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
        <div className="row-span-2 flex items-center">
          <DatabaseMark engine={file.engine} />
        </div>
        <h3 className="truncate text-sm font-semibold">{file.name}</h3>
        <StatusTag
          label={file.needsAttention ? file.status === 'stopped' ? '文件不可用' : '需要处理' : DATABASE_STATUS_LABELS[file.status]}
          tone={FILE_STATUS_TONE[file.status]}
        />
        <p className="truncate text-xs text-fg-muted">
          {file.engine} · {file.version}
        </p>
        <time dateTime={file.updatedAt} className="whitespace-nowrap text-xs text-fg-subtle">
          更新于 {formatDateTime(file.updatedAt)}
        </time>
      </div>
      {/* 文件型：来源是一个本地 .db 文件，没有容器详情可看；点击把路径复制走。 */}
      <Button unstyled
        type="button"
        onClick={() => void copyFilePath(file.filePath ?? '', '文件路径')}
        title="点击复制文件路径"
        aria-label={`复制数据库文件路径 ${file.filePath ?? ''}`}
        className="flex w-full items-center gap-2 rounded-lg bg-surface-raised px-3 py-2 text-left text-xs text-fg-muted transition-colors hover:bg-surface-raised/70 hover:text-fg"
      >
        {pathCopied ? (
          <Check aria-hidden size={14} className="shrink-0 text-success" />
        ) : (
          <File aria-hidden size={14} className="shrink-0 text-fg-subtle" />
        )}
        <span className="hidden shrink-0 @sm:inline">{pathCopied ? '已复制' : '数据库文件'}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-fg" title={file.filePath}>
          {file.filePath}
        </span>
        <span className="hidden shrink-0 tabular-nums text-fg-subtle @xs:inline">
          {formatFileSize(file.fileSizeMb)}
        </span>
      </Button>

      {/* 文件型只有事实，没有配额：三格都是静态值，不画占比条。 */}
      <div className="grid grid-cols-1 gap-2.5 @lg:grid-cols-3">
        <FileStat
          icon={<File aria-hidden size={14} />}
          label="文件大小"
          value={formatFileSize(file.fileSizeMb)}
        />
        <FileStat
          icon={<Database aria-hidden size={14} />}
          label="表数量"
          value={file.tableCount === undefined ? '不可用' : String(file.tableCount)}
        />
        <FileStat
          icon={<Timer aria-hidden size={14} />}
          label="最后写入"
          value={file.lastWrittenAt ? formatDateTime(file.lastWrittenAt) : '不可用'}
        />
      </div>
      {file.metricsError ? <p role="status" className="text-xs text-warning">状态核对失败：{file.metricsError}</p> : null}
      {file.needsAttention ? <div className="rounded-lg border border-warning/40 p-2 text-xs text-warning"><p>SQLite 文件不可用或操作尚未完成。可重新核对；确认放弃时可清理登记及残留文件。</p><div className="mt-2 flex gap-2"><Button variant="outline" type="button" onClick={() => void performAction(() => gateway.databases.reconcileSqlite(file.id), `SQLite 文件 ${file.name} 已重新核对`, true)} className="rounded border border-line px-2 py-1">重新核对</Button><Button variant="outline" type="button" onClick={() => void performAction(() => gateway.databases.forgetSqlite(file.id), `已清理 SQLite 文件 ${file.name} 的待处理登记`, true)} className="rounded border border-line px-2 py-1">清理待处理文件</Button></div></div> : null}

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {file.source === 'managed' && file.status === 'running' ? <Button variant="outline" type="button" onClick={() => void performAction(() => gateway.databases.downloadSqlite(file.id), `已发起数据库 ${file.name} 的快照下载`)} title="下载一致性 SQLite 快照" className="action-button gap-1.5 border border-line px-3 py-1.5 text-xs"><Download aria-hidden size={13} />下载快照</Button> : null}
          <Button variant="destructive"
            type="button"
            onClick={() => setConfirmRemove(true)}
            disabled={removing}
            className="action-button shrink-0 gap-1.5 border border-danger/40 px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 aria-hidden size={13} />
            删除文件
          </Button>
        </div>
      </div>
      {confirmRemove ? (
        <ConfirmDialog
          title={`确认删除 SQLite 文件「${file.name}」？`}
          description={<p className="mt-1.5 text-xs text-fg-muted">将永久删除面板管理目录中的实际 SQLite 数据库文件。请先下载快照备份；此操作无法撤销。</p>}
          danger confirmLabel="确认删除"
          onClose={() => setConfirmRemove(false)}
          onConfirm={() => { setConfirmRemove(false); onRemove() }}
        />
      ) : null}
    </article>
  )
}

/** 引擎标：MariaDB 与 MySQL 有官方 Logo，其余引擎（Redis、SQLite 等）回退通用数据库图标加中性配色。 */
function DatabaseMark({ engine }: { engine: DatabaseEngine }) {
  const mark =
    engine === 'MariaDB'
      ? {
          logo: <MariaDBLogo aria-hidden size={23} />,
          frame: 'border-warning/40 bg-warning/10 text-warning',
        }
      : engine === 'MySQL'
        ? {
            logo: <MySQLLogo aria-hidden size={23} />,
            frame: 'border-info/40 bg-info/10 text-info',
          }
        : {
            logo: <Database aria-hidden size={18} />,
            frame: 'border-control-line bg-surface-raised text-fg-muted',
          }

  return (
    <span
      aria-label={`${engine} 图标`}
      className={`inline-flex size-10 shrink-0 items-center justify-center rounded-lg border text-xs font-bold ${mark.frame}`}
    >
      {mark.logo}
    </span>
  )
}

/** 静态指标格：数据库事实只有当前值、没有配额，因此不画占比条。 */
function FileStat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-raised px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-fg-subtle">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-1 text-sm font-medium tabular-nums text-fg">{value}</p>
    </div>
  )
}

/** 端口映射列表：宿主 IP + 宿主端口 → 容器端口/协议，全部缺省时只报容器端口。 */
function formatPorts(ports: readonly DatabasePortMapping[]): string {
  if (ports.length === 0) return '未发布端口'
  return ports.map((port) => {
    const host = port.hostPort === undefined
      ? undefined
      : port.hostIp ? `${port.hostIp}:${port.hostPort}` : `${port.hostPort}`
    return host ? `${host}→${port.containerPort}/${port.protocol}` : `${port.containerPort}/${port.protocol}`
  }).join('、')
}

/** 文件大小：小于 1MB 用 KB，其余用 MB，避免「0.0 MB」这种读不出信息的显示。 */
function formatFileSize(sizeMb: number | undefined): string {
  if (sizeMb === undefined) return '不可用'
  if (sizeMb < 0.1) return `${Math.round(sizeMb * 1024)} KB`
  return `${sizeMb.toFixed(1)} MB`
}
