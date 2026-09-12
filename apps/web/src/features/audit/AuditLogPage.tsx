import { AUDIT_KIND_LABELS } from '@elysian/contracts'
import type { AuditRecord } from '@elysian/contracts'
import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { DataCell, DataRow, DataTable } from '../../components/DataTable'
import { PageHeader } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import { ToggleChip } from '../../components/ToggleChip'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { formatDateTime } from '../../components/format'
import { useAuditLogStore } from '../../stores/auditLogStore'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { isLiveRecord, projectEventToAuditRecord } from './liveProjection'
import {
  AUDIT_QUERY_KINDS,
  hasActiveAuditFilters,
  matchesAuditQuery,
  parseAuditQuery,
  toAuditSearchParams,
  toggleKind,
} from './query'

const COLUMNS = [
  { key: 'at', header: '时间', width: '132px', numeric: true },
  { key: 'kind', header: '类型', width: '92px' },
  { key: 'actor', header: '操作者', width: '120px' },
  { key: 'subject', header: '对象', width: '22%' },
  { key: 'summary', header: '摘要', width: '40%' },
  { key: 'action', header: '操作', width: '72px' },
]

export function AuditLogPage() {
  const gateway = useGateway()
  const [searchParams, setSearchParams] = useSearchParams()
  const [selected, setSelected] = useState<AuditRecord | undefined>(undefined)

  const queryKey = searchParams.toString()
  const query = useMemo(() => parseAuditQuery(new URLSearchParams(queryKey)), [queryKey])

  const status = useAuditLogStore((state) => state.status)
  const records = useAuditLogStore((state) => state.records)
  const errorMessage = useAuditLogStore((state) => state.errorMessage)
  const load = useAuditLogStore((state) => state.load)

  // 事件流是全应用唯一订阅，这里只读它的最近事件，不再另开连接。
  const recentEvents = useEventStreamStore((state) => state.recent)

  useEffect(() => {
    void load(gateway.audit)
  }, [gateway, load])

  const merged = useMemo(() => {
    const live = recentEvents.map(projectEventToAuditRecord)
    return [...live, ...records].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }, [recentEvents, records])

  const filtered = useMemo(
    () => merged.filter((record) => matchesAuditQuery(record, query)),
    [merged, query],
  )

  const apply = (next: { kinds: readonly string[]; q: string }) => {
    setSearchParams(toAuditSearchParams(next))
  }

  const filteredOut = hasActiveAuditFilters(query)

  return (
    <>
      <PageHeader
        title="审计日志"
        description="事件、决策、工具调用、审批与执行结果的时间顺序记录；事件流到达的新记录会即时出现在最前面并标记为实时。"
        actions={
          <>
            <span className="text-xs text-fg-muted">
              共 {filtered.length} / {merged.length} 条
            </span>
            <button
              type="button"
              onClick={() => void load(gateway.audit)}
              className="rounded border border-line bg-surface-raised px-2 py-1 text-xs text-fg"
            >
              刷新
            </button>
          </>
        }
      />

      <div className="mb-3 space-y-1.5">
        <div role="group" aria-labelledby="audit-kind" className="flex flex-wrap items-center gap-1.5">
          <span id="audit-kind" className="mr-1 text-xs text-fg-subtle">
            类型
          </span>
          {AUDIT_QUERY_KINDS.map((kind) => (
            <ToggleChip
              key={kind}
              label={AUDIT_KIND_LABELS[kind]}
              checked={query.kinds.includes(kind)}
              onChange={() => apply({ ...query, kinds: toggleKind(query.kinds, kind) })}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="audit-search" className="text-xs text-fg-subtle">
            搜索
          </label>
          <input
            id="audit-search"
            type="search"
            value={query.q}
            placeholder="摘要、详情、对象或追踪标识"
            onChange={(event) => apply({ ...query, q: event.target.value })}
            className="w-72 rounded border border-line bg-surface px-2 py-0.5 text-xs text-fg placeholder:text-fg-subtle"
          />
          {filteredOut ? (
            <button
              type="button"
              onClick={() => apply({ kinds: [], q: '' })}
              className="rounded border border-line px-2 py-0.5 text-xs text-fg-muted"
            >
              清除筛选
            </button>
          ) : null}
        </div>
      </div>

      {status === 'error' ? (
        <ErrorState
          title="审计记录加载失败"
          description={errorMessage}
          onRetry={() => void load(gateway.audit)}
        />
      ) : status === 'loading' && merged.length === 0 ? (
        <LoadingState label="正在加载审计记录…" />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="当前筛选条件下没有审计记录"
          description={
            filteredOut
              ? '这不是没有记录，而是筛选条件排除了全部条目。清除筛选可以看回完整列表。'
              : '数据集里还没有任何审计记录。'
          }
        />
      ) : (
        <DataTable label="审计记录" columns={COLUMNS}>
          {filtered.map((record) => (
            <DataRow key={record.id}>
              <DataCell numeric muted>
                {formatDateTime(record.at)}
              </DataCell>
              <DataCell>
                <StatusTag label={AUDIT_KIND_LABELS[record.kind]} tone="info" />
              </DataCell>
              <DataCell muted>{record.actor}</DataCell>
              <DataCell muted>
                <code className="text-xs">{record.subject}</code>
              </DataCell>
              <DataCell>
                <span className="text-sm">{record.summary}</span>
                {isLiveRecord(record) ? (
                  <span className="ml-1.5 text-xs text-accent">实时</span>
                ) : null}
              </DataCell>
              <DataCell>
                <button
                  type="button"
                  onClick={() => setSelected(record)}
                  className="rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted hover:text-fg"
                >
                  详情
                </button>
              </DataCell>
            </DataRow>
          ))}
        </DataTable>
      )}

      <Dialog.Root
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-50 w-[min(40rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded border border-line bg-surface p-3"
          >
            <div className="mb-2 flex items-start justify-between gap-3 border-b border-line pb-1.5">
              <Dialog.Title className="text-sm font-semibold">审计记录详情</Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="关闭详情"
                  className="inline-flex size-6 items-center justify-center rounded text-fg-muted"
                >
                  <X aria-hidden size={14} />
                </button>
              </Dialog.Close>
            </div>

            {selected ? (
              <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-xs text-fg-subtle">标识</dt>
                <dd className="break-all font-mono text-xs">{selected.id}</dd>
                <dt className="text-xs text-fg-subtle">时间</dt>
                <dd className="tabular-nums">{formatDateTime(selected.at)}</dd>
                <dt className="text-xs text-fg-subtle">类型</dt>
                <dd>{AUDIT_KIND_LABELS[selected.kind]}</dd>
                <dt className="text-xs text-fg-subtle">操作者</dt>
                <dd>{selected.actor}</dd>
                <dt className="text-xs text-fg-subtle">对象</dt>
                <dd className="font-mono text-xs">{selected.subject}</dd>
                <dt className="text-xs text-fg-subtle">摘要</dt>
                <dd>{selected.summary}</dd>
                <dt className="text-xs text-fg-subtle">详情</dt>
                <dd className="whitespace-pre-wrap break-all text-xs text-fg-muted">
                  {selected.detail}
                </dd>
                <dt className="text-xs text-fg-subtle">追踪标识</dt>
                <dd className="break-all font-mono text-xs">{selected.traceId}</dd>
              </dl>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
