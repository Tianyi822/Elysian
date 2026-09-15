import type { ReactNode } from 'react'
import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router'
import {
  ChevronRight,
  Container,
  Database,
  Gauge,
  KeyRound,
  MariaDBLogo,
  MemoryStick,
  MySQLLogo,
  TriangleAlert,
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

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

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
    <section aria-label="数据库实例" className="mb-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-base font-semibold">{engine} 实例</h2>
        <span className="text-xs tabular-nums text-fg-muted">{filtered.length} 个实例</span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={`这台机器上没有 ${engine} 的数据库容器`}
          description="数据库由容器承载：添加对应的数据库容器后，它的实例会出现在这里。"
        />
      ) : (
        <ul aria-label={`${engine} 数据库列表`} className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {filtered.map((database) => (
            <li key={database.id} className="h-full">
              <DatabaseCard
                database={database}
                view={projectDatabaseCard(database, containerById, imageById, new Date())}
                onJump={() => {
                  useContainersStore.getState().openDetail(database.containerId)
                  useContainersStore.getState().setView('grid')
                  navigate('/containers')
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function DatabaseCard({
  database,
  view,
  onJump,
}: {
  database: DatabaseInstance
  view: DatabaseCardView
  onJump(): void
}) {
  const storagePercent = percent(database.storage.usedGb, database.storage.totalGb)
  const memoryPercent = percent(database.memory.usedGb, database.memory.totalGb)
  const connectionPercent = percent(database.connections.active, database.connections.max)

  return (
    <article
      aria-label={`${database.engine} 数据库 ${database.name}`}
      className="flex h-full flex-col gap-4 rounded-xl border border-line bg-surface p-4 md:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <DatabaseMark engine={database.engine} />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{database.name}</h3>
            <p className="mt-0.5 text-xs text-fg-muted">
              {database.engine} · {database.version}
            </p>
          </div>
        </div>
        <StatusTag label={DATABASE_STATUS_LABELS[database.status]} tone={STATUS_TONE[database.status]} />
      </div>

      <button
        type="button"
        onClick={onJump}
        disabled={view.missingContainer}
        title={view.missingContainer ? '来源容器已不存在' : `打开容器 ${view.container?.name} 的详情`}
        className="flex w-full items-center gap-2 rounded-lg bg-surface-raised px-3 py-2 text-left text-xs text-fg-muted transition-colors hover:bg-surface-raised/70 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Container aria-hidden size={14} className="shrink-0 text-fg-subtle" />
        <span className="shrink-0">来源容器</span>
        {view.missingContainer ? (
          <span className="min-w-0 flex-1 truncate text-fg-subtle">来源容器已不存在</span>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-fg">{view.container?.name}</span>
            <span className="shrink-0 tabular-nums text-fg-subtle">
              {view.imageLabel} · {view.uptimeLabel}
            </span>
            <ChevronRight aria-hidden size={14} className="shrink-0 text-fg-subtle" />
          </>
        )}
      </button>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <CopyButton
          label="复制用户名"
          value={database.credentials.username}
          tooltip="复制演示用户名 · 不对应任何真实数据库"
          icon={<UserRound aria-hidden size={13} />}
        />
        <CopyButton
          label="复制密码"
          value={database.credentials.password}
          tooltip="复制演示密码 · 不对应任何真实数据库"
          icon={<KeyRound aria-hidden size={13} />}
        />
        <span className="ml-auto text-xs text-fg-subtle">演示凭证 · 不对应任何真实数据库</span>
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-line pt-3 text-xs text-fg-subtle">
        <span className="inline-flex items-center gap-1.5">
          {database.status === 'warning' ? <TriangleAlert aria-hidden size={13} /> : <Database aria-hidden size={13} />}
          演示数值 · 待接入真实采集
        </span>
        <time dateTime={database.updatedAt}>更新于 {formatDateTime(database.updatedAt)}</time>
      </div>
    </article>
  )
}

function DatabaseMark({ engine }: { engine: DatabaseInstance['engine'] }) {
  const isMaria = engine === 'MariaDB'
  return (
    <span
      aria-label={`${engine} 图标`}
      className={`inline-flex size-10 shrink-0 items-center justify-center rounded-lg border text-xs font-bold ${
        isMaria
          ? 'border-[#c86b38]/40 bg-[#c86b38]/10 text-[#d98752]'
          : 'border-[#00758f]/40 bg-[#00758f]/10 text-[#2da6bd]'
      }`}
    >
      {isMaria ? <MariaDBLogo aria-hidden size={23} /> : <MySQLLogo aria-hidden size={23} />}
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
