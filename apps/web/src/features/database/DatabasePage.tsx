import type { ReactNode } from 'react'
import { useEffect } from 'react'
import {
  Database,
  Gauge,
  MariaDBLogo,
  MemoryStick,
  MySQLLogo,
  Server,
  TriangleAlert,
} from '../../components/icons'
import { ErrorState, EmptyState, LoadingState } from '../../components/states/StateViews'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { useGateway } from '../../adapters/GatewayProvider'
import type { DatabaseInstance, DatabaseStatus } from '@elysian/contracts'
import { useDatabaseStore } from '../../stores/databaseStore'
import { formatDateTime } from '../../components/format'

const STATUS_TONE: Record<DatabaseStatus, StatusTone> = {
  running: 'success',
  warning: 'warning',
  stopped: 'danger',
}

/** 数据库区只呈现资源状态，不包含账号、密码等连接凭证。 */
export function DatabasePage() {
  const gateway = useGateway()
  const status = useDatabaseStore((state) => state.status)
  const engine = useDatabaseStore((state) => state.engine)
  const databases = useDatabaseStore((state) => state.databases)
  const errorMessage = useDatabaseStore((state) => state.errorMessage)
  const load = useDatabaseStore((state) => state.load)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

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
        <div>
          <h2 className="text-base font-semibold">{engine} 实例</h2>
          <p className="mt-1 text-sm text-fg-muted">
            展示容量、内存与连接使用情况，数据来自本地演示集。
          </p>
        </div>
        <span className="text-xs tabular-nums text-fg-muted">{filtered.length} 个实例</span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={`暂未接入 ${engine}`}
          description="当前演示集只提供 MariaDB 与 MySQL 的数据库卡片。"
        />
      ) : (
        <ul aria-label={`${engine} 数据库列表`} className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {filtered.map((database) => (
            <li key={database.id} className="h-full">
              <DatabaseCard database={database} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function DatabaseCard({ database }: { database: DatabaseInstance }) {
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
        <StatusTag label={database.statusLabel} tone={STATUS_TONE[database.status]} />
      </div>

      <div className="flex items-center gap-2 rounded-lg bg-surface-raised px-3 py-2 text-xs text-fg-muted">
        <Server aria-hidden size={14} className="shrink-0 text-fg-subtle" />
        <code className="min-w-0 truncate text-fg" title={`${database.host}:${database.port}`}>
          {database.host}:{database.port}
        </code>
        <span className="ml-auto shrink-0 text-fg-subtle">运行 {database.uptime}</span>
      </div>

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
        />
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-line pt-3 text-xs text-fg-subtle">
        <span className="inline-flex items-center gap-1.5">
          {database.status === 'warning' ? <TriangleAlert aria-hidden size={13} /> : <Database aria-hidden size={13} />}
          状态采样正常
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
}: {
  icon: ReactNode
  label: string
  value: string
  percent: number
  warning?: boolean
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
        title={`${label}已使用 ${percent}%`}
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
