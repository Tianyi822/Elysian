import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import * as Dialog from '@radix-ui/react-dialog'
import {
  Cable,
  ChevronRight,
  Container,
  Database,
  Gauge,
  KeyRound,
  MariaDBLogo,
  MemoryStick,
  MySQLLogo,
  Plus,
  Trash2,
  UserRound,
} from '../../components/icons'
import { CopyButton } from '../../components/CopyButton'
import { ErrorState, EmptyState, LoadingState } from '../../components/states/StateViews'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { useGateway } from '../../adapters/GatewayProvider'
import { DATABASE_STATUS_LABELS } from '@elysian/contracts'
import type { DatabaseInstance, DatabaseStatus } from '@elysian/contracts'
import { useDatabaseStore } from '../../stores/databaseStore'
import { useContainersStore } from '../../stores/containersStore'
import { formatDateTime } from '../../components/format'
import { projectDatabaseCard } from './projectDatabaseCard'
import type { DatabaseCardView } from './projectDatabaseCard'
import { SqlSessionWindow } from './SqlSessionWindow'
import { DatabaseCreateDialog } from './DatabaseCreateDialog'

const STATUS_TONE: Record<DatabaseStatus, StatusTone> = {
  running: 'success',
  warning: 'warning',
  stopped: 'danger',
}

/** 数据库区呈现资源状态；演示凭证值不上屏，只提供一键复制动作。 */
export function DatabasePage() {
  const gateway = useGateway()
  const navigate = useNavigate()
  const status = useDatabaseStore((state) => state.status)
  const engine = useDatabaseStore((state) => state.engine)
  const databases = useDatabaseStore((state) => state.databases)
  const containers = useDatabaseStore((state) => state.containers)
  const images = useDatabaseStore((state) => state.images)
  const errorMessage = useDatabaseStore((state) => state.errorMessage)
  const load = useDatabaseStore((state) => state.load)
  const openSession = useDatabaseStore((state) => state.openSession)
  const openCreate = useDatabaseStore((state) => state.openCreate)
  const removingDatabaseIds = useDatabaseStore((state) => state.removingDatabaseIds)
  const removeDatabase = useDatabaseStore((state) => state.removeDatabase)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  // 会话随页面卸载清空：离开数据库页即关闭演示会话，不跨页保留旧输出与历史。
  useEffect(() => () => useDatabaseStore.getState().closeSession(), [])

  const containerById = useMemo(
    () => new Map(containers.map((container) => [container.id, container])),
    [containers],
  )
  const imageById = useMemo(() => new Map(images.map((image) => [image.id, image])), [images])

  if (status === 'error') {
    return (
      <ErrorState
        title="数据库数据加载失败"
        description={errorMessage}
        onRetry={() => void load(gateway)}
      />
    )
  }

  if (status !== 'ready') return <LoadingState label="正在加载数据库数据…" />

  const filtered = databases.filter((database) => database.engine === engine)

  return (
    <>
      <section aria-label="数据库实例" className="mb-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{engine} 实例</h2>
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle"
          >
            <Plus aria-hidden size={13} />
            添加数据库
          </button>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            title={`这台机器上没有 ${engine} 的数据库容器`}
            description="数据库由容器承载：添加对应的数据库容器后，它的实例会出现在这里。"
          />
        ) : (
          /* 列数量内容区的实测宽度（容器查询）而非视口：侧边栏收展改变可用宽度，卡片随之增减，不会出现「空间变大卡片反而变小」的倒挂。 */
          <div className="@container">
            <ul
              aria-label={`${engine} 数据库列表`}
              className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3"
            >
              {filtered.map((database) => (
              <li key={database.id} className="h-full">
                <DatabaseCard
                  database={database}
                  view={projectDatabaseCard(database, containerById, imageById)}
                  removing={removingDatabaseIds.includes(database.id)}
                  onJump={() => {
                    useContainersStore.getState().openDetail(database.containerId)
                    useContainersStore.getState().setView('grid')
                    navigate('/containers')
                  }}
                  onConnect={() => openSession(database.id)}
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
    </>
  )
}

function DatabaseCard({
  database,
  view,
  removing,
  onJump,
  onConnect,
  onRemove,
}: {
  database: DatabaseInstance
  view: DatabaseCardView
  removing: boolean
  onJump(): void
  onConnect(): void
  onRemove(databaseId: string): void
}) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const storagePercent = percent(database.storage.usedGb, database.storage.totalGb)
  const memoryPercent = percent(database.memory.usedGb, database.memory.totalGb)
  const connectionPercent = percent(database.connections.active, database.connections.max)

  return (
    <article
      aria-label={`${database.engine} 数据库 ${database.name}`}
      className="@container flex h-full flex-col gap-3 rounded-xl border border-line bg-surface p-4 md:p-5"
    >
      {/* 头部是两行网格：图标跨两行；第一行实例名对状态标签，第二行版本对更新时间——左右同行同基线，不再各自堆叠错位。 */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
        <div className="row-span-2 flex items-center">
          <DatabaseMark engine={database.engine} />
        </div>
        <h3 className="truncate text-sm font-semibold">{database.name}</h3>
        <StatusTag label={DATABASE_STATUS_LABELS[database.status]} tone={STATUS_TONE[database.status]} />
        <p className="truncate text-xs text-fg-muted">
          {database.engine} · {database.version}
        </p>
        <time dateTime={database.updatedAt} className="whitespace-nowrap text-xs text-fg-subtle">
          更新于 {formatDateTime(database.updatedAt)}
        </time>
      </div>

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

      {/* 指标格随卡片实际宽度分栏：三列布局下卡片窄、指标竖排，宽卡才三格横排（容器查询而非视口断点）。 */}
      <div className="grid grid-cols-1 gap-2.5 @lg:grid-cols-3">
        <UsageMetric
          icon={<Database aria-hidden size={14} />}
          label="容量"
          value={`${database.storage.usedGb.toFixed(1)} / ${database.storage.totalGb} GB`}
          percent={storagePercent}
        />
        <UsageMetric
          icon={<MemoryStick aria-hidden size={14} />}
          label="内存占用"
          value={`${database.memory.usedGb.toFixed(1)} / ${database.memory.totalGb} GB`}
          percent={memoryPercent}
        />
        <UsageMetric
          icon={<Gauge aria-hidden size={14} />}
          label="连接数"
          value={`${database.connections.active} / ${database.connections.max}`}
          percent={connectionPercent}
          warning={database.status === 'warning'}
          demo
        />
      </div>

      {/* 动作行沉底：卡片因同列内容高度不齐被拉伸时，操作区贴住卡底。 */}
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <CopyButton
          label="用户名"
          value={database.credentials.username}
          tooltip="复制演示用户名 · 不对应任何真实数据库"
          icon={<UserRound aria-hidden size={13} />}
        />
        <CopyButton
          label="密码"
          value={database.credentials.password}
          tooltip="复制演示密码 · 不对应任何真实数据库"
          icon={<KeyRound aria-hidden size={13} />}
        />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setConfirmRemove(true)}
            disabled={removing}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-danger/40 px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 aria-hidden size={13} />
            删除
          </button>
          <button
            type="button"
            onClick={onConnect}
            disabled={removing}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Cable aria-hidden size={13} />
            连接
          </button>
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
            <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface-raised p-4 shadow-xl"
            >
              <Dialog.Title className="text-sm font-semibold">
                确认删除数据库「{database.name}」？
              </Dialog.Title>
              <p className="mt-1.5 text-xs text-fg-muted">
                删除只作用于演示数据：卡片与它的演示会话一并移除，刷新页面即恢复，不会触碰任何真实数据库。
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
    </article>
  )
}

/** 引擎标：MariaDB 与 MySQL 有官方 Logo，其余引擎（Redis 等）回退通用数据库图标加中性配色。 */
function DatabaseMark({ engine }: { engine: DatabaseInstance['engine'] }) {
  const mark =
    engine === 'MariaDB'
      ? {
          logo: <MariaDBLogo aria-hidden size={23} />,
          frame: 'border-[#c86b38]/40 bg-[#c86b38]/10 text-[#d98752]',
        }
      : engine === 'MySQL'
        ? {
            logo: <MySQLLogo aria-hidden size={23} />,
            frame: 'border-[#00758f]/40 bg-[#00758f]/10 text-[#2da6bd]',
          }
        : {
            logo: <Database aria-hidden size={18} />,
            frame: 'border-line bg-surface-raised text-fg-muted',
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

function UsageMetric({
  icon,
  label,
  value,
  percent,
  warning = false,
  demo = false,
}: {
  icon: ReactNode
  label: string
  value: string
  percent: number
  warning?: boolean
  /** 连接数补演示标注：条形 tooltip 明说数值待接入真实采集。 */
  demo?: boolean
}) {
  return (
    <div className="rounded-lg bg-surface-raised px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-fg-subtle">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-1 text-sm font-medium tabular-nums text-fg">{value}</p>
      <div
        aria-hidden
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-line"
        title={`${label}已使用 ${percent}%${demo ? '（演示数值 · 待接入真实采集）' : ''}`}
      >
        <div
          className={`h-full rounded-full ${warning ? 'bg-warning' : 'bg-info'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

function percent(used: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)))
}
