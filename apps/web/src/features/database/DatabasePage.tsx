import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  Cable,
  ChevronRight,
  Check,
  Container,
  Database,
  Download,
  Gauge,
  MariaDBLogo,
  MemoryStick,
  MySQLLogo,
  File,
  Timer,
  Trash2,
} from '../../components/icons'
import { useClipboardCopy } from '../../components/CopyButton'
import { CTL_PRIMARY, CTL_TOOLBAR } from '../../components/formControl'
import { ErrorState, EmptyState, LoadingState } from '../../components/states/StateViews'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { useGateway } from '../../adapters/GatewayProvider'
import { DATABASE_STATUS_LABELS } from '@elysian/contracts'
import type { DatabaseInstance, DatabaseStatus } from '@elysian/contracts'
import { useDatabaseStore } from '../../stores/databaseStore'
import { useContainersStore } from '../../stores/containersStore'
import { useDependencyProbeStore } from '../../stores/dependencyProbeStore'
import { formatDateTime } from '../../components/format'
import { projectDatabaseCard } from './projectDatabaseCard'
import type { DatabaseCardView } from './projectDatabaseCard'
import { SqlSessionWindow } from './SqlSessionWindow'
import { DatabaseCreateDialog } from './DatabaseCreateDialog'
import { ContainerDetailSheet } from '../container/ContainerDetailSheet'
import { useFeedbackNotification } from '../../components/useFeedbackNotification'
import { useNotificationStore } from '../../stores/notificationStore'

const STATUS_TONE: Record<DatabaseStatus, StatusTone> = {
  running: 'success',
  warning: 'warning',
  stopped: 'danger',
}

/** 数据库区展示 Docker 运行时承载的真实服务与 SQLite 文件；本地非 Docker 运行时数据库端点不可用，页面落入错误态。 */
export function DatabasePage() {
  const gateway = useGateway()
  const status = useDatabaseStore((state) => state.status)
  const engine = useDatabaseStore((state) => state.engine)
  const databases = useDatabaseStore((state) => state.databases)
  const containers = useDatabaseStore((state) => state.containers)
  const images = useDatabaseStore((state) => state.images)
  const errorMessage = useDatabaseStore((state) => state.errorMessage)
  const refreshing = useDatabaseStore((state) => state.refreshing)
  const load = useDatabaseStore((state) => state.load)
  const refresh = useDatabaseStore((state) => state.refresh)
  const openSession = useDatabaseStore((state) => state.openSession)
  const openCreate = useDatabaseStore((state) => state.openCreate)
  const removingDatabaseIds = useDatabaseStore((state) => state.removingDatabaseIds)
  const removeDatabase = useDatabaseStore((state) => state.removeDatabase)
  const check = useDependencyProbeStore((state) => state.check)

  useEffect(() => {
    void load(gateway)
    // 依赖检测幂等：切页重挂不重探，报告由探测层消费。
    void check(gateway)
  }, [gateway, load, check])
  useEffect(() => {
    if (!gateway.databases.openTerminal) return
    const timer = window.setInterval(() => { void refresh(gateway) }, 15_000)
    return () => window.clearInterval(timer)
  }, [gateway, refresh])

  // 会话随页面卸载清空，避免连接跨页保留。
  useEffect(() => () => useDatabaseStore.getState().closeSession(), [])

  const containerById = useMemo(
    () => new Map(containers.map((container) => [container.id, container])),
    [containers],
  )
  const imageById = useMemo(() => new Map(images.map((image) => [image.id, image])), [images])

  // 来源容器行在当前页就地打开详情侧边栏，不跳容器页：容器页数据可能还没加载过，
  // 把这一只容器与它的镜像补进容器 store（与容器数据集同源同形），详情面板据此渲染。
  const openContainerDetail = (containerId: string) => {
    const container = containerById.get(containerId)
    if (!container) return
    const image = imageById.get(container.imageId)
    useContainersStore.setState((state) => ({
      containers: state.containers.some((c) => c.id === containerId)
        ? state.containers
        : [...state.containers, container],
      images: !image || state.images.some((i) => i.id === image.id)
        ? state.images
        : [...state.images, image],
      detailContainerId: containerId,
    }))
  }

  if (status === 'error') {
    return (
      <ErrorState
        title="数据库数据加载失败"
        description={errorMessage}
        onRetry={() => void load(gateway)}
      />
    )
  }

  if (status !== 'ready') {
    return <LoadingState label="正在加载数据库数据…" />
  }

  const filtered = databases.filter((database) => database.engine === engine)

  return (
    <>
      <section aria-label="数据库实例" className="mb-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{engine} 实例</h2>
          <div className={`${CTL_TOOLBAR} flex flex-wrap items-center gap-2`}>
            <RefreshButton onPress={() => void refresh(gateway, true)} busy={refreshing} formControl />
            <button type="button" onClick={openCreate} className={CTL_PRIMARY}>
              添加数据库
            </button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            title={`没有 ${engine} 数据库`}
            description={engine === 'SQLite' ? '新建 SQLite 文件或上传独立数据库快照。' : '选择已有容器添加数据库，或在当前窗口拉取镜像并创建新容器。'}
          />
        ) : (
          /* 列数量内容区的实测宽度（容器查询）而非视口：侧边栏收展改变可用宽度，卡片随之增减，不会出现「空间变大卡片反而变小」的倒挂。 */
          <div className="@container">
            <ul
              aria-label={`${engine} 数据库列表`}
              className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-4"
            >
              {filtered.map((database) => (
                <li key={database.id} className="h-full">
                  <DatabaseCard
                    database={database}
                    view={projectDatabaseCard(database, containerById, imageById)}
                    removing={removingDatabaseIds.includes(database.id)}
                    refreshing={refreshing}
                    onJump={() => {
                      if (database.containerId) openContainerDetail(database.containerId)
                    }}
                    onConnect={() => openSession(database.id, gateway)}
                    onRemove={(databaseId) => void removeDatabase(gateway, databaseId)}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <SqlSessionWindow />
      <DatabaseCreateDialog />
      <ContainerDetailSheet />
    </>
  )
}

function DatabaseCard({
  database,
  view,
  removing,
  refreshing = false,
  onJump,
  onConnect,
  onRemove,
}: {
  database: DatabaseInstance
  view: DatabaseCardView
  removing: boolean
  /** 列表刷新在途：卡片内容不换，只由自身盖一层浅色遮罩示意进行中。 */
  refreshing?: boolean
  onJump(): void
  onConnect(): void
  onRemove(databaseId: string): void
}) {
  const gateway = useGateway()
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmRemoveContainer, setConfirmRemoveContainer] = useState(false)
  const [credentialError, setCredentialError] = useState('')
  useFeedbackNotification(credentialError)
  useFeedbackNotification(database.metricsError ? `${database.name}：${database.metricsError}` : null, 'warning')
  const { copied: pathCopied, copy: copyFilePath } = useClipboardCopy()
  const { copy: copyCredential } = useClipboardCopy()

  const performAction = async (action: () => Promise<unknown> | undefined, message: string, refresh?: 'load' | 'refresh') => {
    setCredentialError('')
    try {
      const operation = action()
      if (!operation) return
      await operation
      useNotificationStore.getState().notify({ tone: 'success', message })
      if (refresh) await useDatabaseStore.getState()[refresh](gateway)
    } catch (error) {
      setCredentialError(error instanceof Error ? error.message : '数据库操作失败')
    }
  }

  const revealAndCopy = async (field: 'username' | 'password') => {
    try {
      if (!gateway.databases.reveal) return
      const secret = await gateway.databases.reveal(database.id)
      await copyCredential(secret[field], field === 'username' ? '用户名' : '密码')
      setCredentialError('')
    } catch (error) { setCredentialError(error instanceof Error ? error.message : '读取凭证失败') }
  }

  return (
    <article
      aria-label={`${database.engine} 数据库 ${database.name}`}
      className="@container flex h-full flex-col gap-3 panel-surface p-4 md:p-5"
    >
      <BusyVeil busy={refreshing} />
      {/* 头部是两行网格：图标跨两行；第一行实例名对状态标签，第二行版本对更新时间——左右同行同基线，不再各自堆叠错位。 */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
        <div className="row-span-2 flex items-center">
          <DatabaseMark engine={database.engine} />
        </div>
        <h3 className="truncate text-sm font-semibold">{database.name}</h3>
        <StatusTag label={database.engine === 'SQLite' && database.needsAttention ? database.status === 'stopped' ? '文件不可用' : '需要处理' : DATABASE_STATUS_LABELS[database.status]} tone={STATUS_TONE[database.status]} />
        <p className="truncate text-xs text-fg-muted">
          {database.engine} · {database.version}
        </p>
        <time dateTime={database.updatedAt} className="whitespace-nowrap text-xs text-fg-subtle">
          更新于 {formatDateTime(database.updatedAt)}
        </time>
      </div>

      {view.kind === 'file' ? (
        /* 文件型：来源是一个本地 .db 文件，没有容器详情可看；点击把路径复制走。 */
        <button
          type="button"
          onClick={() => void copyFilePath(view.filePath, '文件路径')}
          title="点击复制文件路径"
          aria-label={`复制数据库文件路径 ${view.filePath}`}
          className="flex w-full items-center gap-2 rounded-lg bg-surface-raised px-3 py-2 text-left text-xs text-fg-muted transition-colors hover:bg-surface-raised/70 hover:text-fg"
        >
          {pathCopied ? (
            <Check aria-hidden size={14} className="shrink-0 text-success" />
          ) : (
            <File aria-hidden size={14} className="shrink-0 text-fg-subtle" />
          )}
          <span className="hidden shrink-0 @sm:inline">{pathCopied ? '已复制' : '数据库文件'}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-fg" title={view.filePath}>
            {view.filePath}
          </span>
          <span className="hidden shrink-0 tabular-nums text-fg-subtle @xs:inline">
            {formatFileSize(view.fileSizeMb)}
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onJump}
          disabled={view.missingContainer}
          title={view.missingContainer ? '来源容器已不存在' : `打开容器 ${view.container?.name} 的详情`}
          className="flex w-full items-center gap-2 rounded-lg bg-surface-raised px-3 py-2 text-left text-xs text-fg-muted transition-colors hover:bg-surface-raised/70 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {/* 永远单行：卡片越窄依次让出「来源容器」标签（<@sm）与镜像名（<@xs），容器名始终保留并截断。 */}
          <Container aria-hidden size={14} className="shrink-0 text-fg-subtle" />
          <span className="hidden shrink-0 @sm:inline">来源容器</span>
          {view.missingContainer ? (
            <span className="min-w-0 flex-1 truncate text-fg-subtle">来源容器已不存在</span>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-fg">{view.container?.name}</span>
              <span className="hidden shrink-0 tabular-nums text-fg-subtle @xs:inline">
                {view.imageLabel}
              </span>
              <ChevronRight aria-hidden size={14} className="shrink-0 text-fg-subtle" />
            </>
          )}
        </button>
      )}

      {/* 指标格随卡片实际宽度分栏：三列布局下卡片窄、指标竖排，宽卡才三格横排（容器查询而非视口断点）。 */}
      <div className="grid grid-cols-1 gap-2.5 @lg:grid-cols-3">
        {view.kind === 'file' ? (
          <>
            {/* 文件型只有事实，没有配额：三格都是静态值，不画占比条。 */}
            <FileStat
              icon={<File aria-hidden size={14} />}
              label="文件大小"
              value={formatFileSize(view.fileSizeMb)}
            />
            <FileStat
              icon={<Database aria-hidden size={14} />}
              label="表数量"
              value={database.tableCount === undefined ? '不可用' : String(database.tableCount)}
            />
            <FileStat
              icon={<Timer aria-hidden size={14} />}
              label="最后写入"
              value={database.lastWrittenAt ? formatDateTime(database.lastWrittenAt) : '不可用'}
            />
          </>
        ) : (
          <>
            <FileStat icon={<Database aria-hidden size={14} />} label="已用空间" value={database.storage ? `${(database.storage.usedGb * 1024).toFixed(1)} MB` : '不可用'} />
            <FileStat icon={<MemoryStick aria-hidden size={14} />} label="容器内存" value={database.memory ? `${(database.memory.usedGb * 1024).toFixed(1)} MB` : '不可用'} />
            <FileStat icon={<Gauge aria-hidden size={14} />} label="连接数" value={database.connections ? `${database.connections.active}${database.connections.max ? ` / ${database.connections.max}` : ''}` : '不可用'} />
          </>
        )}
      </div>
      {database.metricsError ? <p role="status" className="text-xs text-warning">{database.emptyContainer ? database.metricsError : `状态核对失败：${database.metricsError}`}</p> : null}
      {database.needsAttention ? <div className="rounded-lg border border-warning/40 p-2 text-xs text-warning"><p>{database.engine === 'SQLite' ? 'SQLite 文件不可用或操作尚未完成。可重新核对；确认放弃时可清理登记及残留文件。' : '创建或接管尚未完成。修复容器和账号后可重新核对；不再接管时可移除待处理登记。'}</p><div className="mt-2 flex gap-2"><button type="button" onClick={() => void performAction(() => gateway.databases.reconcile?.(database.id), `数据库 ${database.name} 已重新核对`, 'refresh')} className="rounded border border-line px-2 py-1">重新核对</button>{database.source === 'adopted' || database.engine === 'SQLite' ? <button type="button" onClick={() => void performAction(() => gateway.databases.forget?.(database.id), `已清理数据库 ${database.name} 的待处理登记`, 'refresh')} className="rounded border border-line px-2 py-1">{database.engine === 'SQLite' ? '清理待处理文件' : '移除待处理登记'}</button> : null}</div></div> : null}

      {/* 动作行沉底：卡片因同列内容高度不齐被拉伸时，操作区贴住卡底。 */}
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {/* SQLite 没有账号体系：不摆一对复制不了任何东西的按钮，也不占位说明。
            服务型凭证只在用户点击复制时经 reveal 端点按需读取，列表响应没有明文渲染位。 */}
        {database.hasCredentials && gateway.databases.reveal ? (
          <>
            <button type="button" onClick={() => void revealAndCopy('username')} title="从服务端读取并复制普通账号" className="rounded border border-line px-2 py-1 text-xs">复制用户名</button>
            <button type="button" onClick={() => void revealAndCopy('password')} title="从服务端读取并复制普通账号密码" className="rounded border border-line px-2 py-1 text-xs">复制密码</button>
          </>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {database.engine === 'SQLite' && database.source === 'managed' && database.status === 'running' && gateway.databases.downloadSqlite ? <button type="button" onClick={() => void performAction(() => gateway.databases.downloadSqlite?.(database.id), `已发起数据库 ${database.name} 的快照下载`)} title="下载一致性 SQLite 快照" className="action-button gap-1.5 border border-line px-3 py-1.5 text-xs"><Download aria-hidden size={13} />下载快照</button> : null}
          {!database.emptyContainer ? <button
            type="button"
            onClick={() => setConfirmRemove(true)}
            disabled={removing}
            className="action-button shrink-0 gap-1.5 border border-danger/40 px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 aria-hidden size={13} />
            {database.engine === 'Redis' ? '清空 DB 0' : '删除数据库'}
          </button> : null}
          {database.engine !== 'SQLite' && database.source === 'managed' && gateway.databases.removeContainer ? <button type="button" onClick={() => setConfirmRemoveContainer(true)} className="rounded-lg border border-danger/40 px-2 py-1.5 text-xs text-danger">删除容器及数据</button> : null}
          {!database.emptyContainer ? <button
            type="button"
            onClick={onConnect}
            disabled={removing || database.emptyContainer || database.status === 'stopped'}
            className="action-button shrink-0 gap-1.5 border border-control-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Cable aria-hidden size={13} />
            连接
          </button> : null}
        </div>
      </div>

      {confirmRemove ? (
        <Dialog.Root
          open
          onOpenChange={(next) => {
            if (!next) setConfirmRemove(false)
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl"
            >
              <Dialog.Title className="text-sm font-semibold">
                确认删除数据库「{database.name}」？
              </Dialog.Title>
              <p className="mt-1.5 text-xs text-fg-muted">
                {database.engine === 'SQLite' && database.source === 'managed'
                  ? '将永久删除面板管理目录中的实际 SQLite 数据库文件。请先下载快照备份；此操作无法撤销。'
                  : database.engine === 'Redis'
                    ? '将清空此 Redis 容器的 DB 0，容器和持久卷保留。此操作无法撤销。'
                    : '将删除目标逻辑库，容器和持久卷保留。此操作无法撤销。'}
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmRemove(false)}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmRemove(false)
                    onRemove(database.id)
                  }}
                  className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/20"
                >
                  确认删除
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
      {confirmRemoveContainer ? <Dialog.Root open onOpenChange={(next) => { if (!next) setConfirmRemoveContainer(false) }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" /><Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl"><Dialog.Title className="text-sm font-semibold">删除容器及全部数据？</Dialog.Title><p className="mt-2 text-xs text-danger">将删除面板创建的数据库容器及其专属持久卷，全部数据无法恢复。容器内有其他数据库时服务端会拒绝。</p><div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setConfirmRemoveContainer(false)} className="rounded border border-line px-3 py-1.5 text-xs">取消</button><button type="button" onClick={() => { setConfirmRemoveContainer(false); void performAction(() => gateway.databases.removeContainer?.(database.id), `已删除数据库 ${database.name} 的容器及数据`, 'load') }} className="rounded border border-danger px-3 py-1.5 text-xs text-danger">确认删除容器及数据</button></div></Dialog.Content></Dialog.Portal></Dialog.Root> : null}
    </article>
  )
}

/** 引擎标：MariaDB 与 MySQL 有官方 Logo，其余引擎（Redis 等）回退通用数据库图标加中性配色。 */
function DatabaseMark({ engine }: { engine: DatabaseInstance['engine'] }) {
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

/** 静态指标格：文件型数据库只有事实、没有配额，因此不画占比条。 */
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

/** 文件大小：小于 1MB 用 KB，其余用 MB，避免「0.0 MB」这种读不出信息的显示。 */
function formatFileSize(sizeMb: number | undefined): string {
  if (sizeMb === undefined) return '不可用'
  if (sizeMb < 0.1) return `${Math.round(sizeMb * 1024)} KB`
  return `${sizeMb.toFixed(1)} MB`
}
