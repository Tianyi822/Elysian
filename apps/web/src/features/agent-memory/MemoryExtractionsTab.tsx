import { useEffect, useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentRunStatusTag } from '../../components/agent/AgentStatusTag'
import { useSilentPolling } from '../../components/agent/useSilentPolling'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { Plus } from '../../components/icons'
import { extractionIsActive, useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { MEMORY_JOB_KIND_LABELS, MEMORY_ORIGIN_KIND_LABELS, MEMORY_STATUS_LABELS } from './memoryLabels'
import { MemoryExtractionCreateDialog } from './MemoryExtractionCreateDialog'
import { MemoryExtractionDetail } from './MemoryExtractionDetail'

/*
 * 「提炼任务」页签：分页列表＋手工创建＋详情轮询。列表只要有非终态任务就静默
 * 轮询（3 秒，隐藏暂停、失败退避），终态回读不驱动刷新按钮。
 */
export function MemoryExtractionsTab({ onOpenProposals }: { onOpenProposals(proposalId?: string, spaceId?: string): void }) {
  const gateway = useGateway()
  const status = useAgentMemoryStore((state) => state.extractionsStatus)
  const reloading = useAgentMemoryStore((state) => state.extractionsReloading)
  const jobs = useAgentMemoryStore((state) => state.extractions)
  const hasMore = useAgentMemoryStore((state) => state.extractionsHasMore)
  const errorMessage = useAgentMemoryStore((state) => state.extractionsErrorMessage)
  const detailId = useAgentMemoryStore((state) => state.detailId)
  const load = useAgentMemoryStore((state) => state.loadExtractions)
  const loadMore = useAgentMemoryStore((state) => state.loadMoreExtractions)
  const loadDetail = useAgentMemoryStore((state) => state.loadExtractionDetail)
  const clearDetail = useAgentMemoryStore((state) => state.clearExtractionDetail)
  const [creating, setCreating] = useState(false)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  const anyActive = jobs.some((job) => extractionIsActive(job))
  const { degraded } = useSilentPolling(
    async (signal) => {
      await load(gateway, { silent: true, signal })
    },
    { intervalMs: 3_000, enabled: status === 'ready' && anyActive },
  )

  return (
    <div className="busy-host relative flex flex-col gap-3">
      <BusyVeil busy={reloading} />
      <div className="flex flex-wrap items-center gap-2">
        {degraded ? <span role="status" className="text-xs text-fg-muted">连接中断，正在重试…</span> : null}
        <span className="ml-auto inline-flex items-center gap-2">
          <RefreshButton label="刷新提炼任务" onPress={() => void load(gateway)} busy={reloading} />
          <button type="button" className={`${CTL_PRIMARY} text-xs`} onClick={() => setCreating(true)}>
            <span className="inline-flex items-center gap-1"><Plus aria-hidden size={13} />手工创建提炼</span>
          </button>
        </span>
      </div>

      {status === 'loading' || status === 'idle' ? <LoadingState label="正在读取提炼任务…" /> : null}
      {status === 'error' ? <ErrorState description={errorMessage} onRetry={() => void load(gateway)} /> : null}
      {status === 'ready' && jobs.length === 0 ? (
        <EmptyState title="暂无提炼任务" description="任务成功结束且会话选定了记忆空间时会自动排队；也可手工从成功的运行或工作流创建。" />
      ) : null}
      {status === 'ready' && jobs.length > 0 ? (
        <div role="region" aria-label="提炼任务列表" className="overflow-x-auto panel-surface">
          <table className="w-full min-w-[48rem] table-fixed border-separate border-spacing-0 text-left text-sm">
            <colgroup>
              <col className="w-[18%]" />
              <col className="w-[12%]" />
              <col className="w-[20%]" />
              <col className="w-[14%]" />
              <col className="w-[12%]" />
              <col className="w-[12%]" />
              <col className="w-[12%]" />
            </colgroup>
            <thead>
              <tr>
                {['任务', '状态', '来源', '记忆状态', '候选', '创建于', ''].map((label, index) => (
                  <th key={label === '' ? `action-${index}` : label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr
                  key={job.id}
                  className={`whitespace-nowrap transition-colors hover:bg-surface-raised ${job.id === selectedId ? 'bg-surface-raised' : ''}`}
                >
                  <td className="border-b border-line px-3 py-2.5 font-mono text-xs text-fg" title={`${job.id} · ${MEMORY_JOB_KIND_LABELS[job.kind]}`}>
                    <button type="button" aria-expanded={job.id === selectedId} className="text-left underline-offset-2 hover:underline" onClick={() => {
                      const next = job.id === selectedId ? undefined : job.id
                      setSelectedId(next)
                      if (next === undefined) clearDetail()
                      else void loadDetail(gateway, next)
                    }}>{job.id}</button>
                  </td>
                  <td className="border-b border-line px-3 py-2.5"><AgentRunStatusTag status={job.status} /></td>
                  <td className="border-b border-line px-3 py-2.5 text-xs text-fg-muted">
                    {MEMORY_ORIGIN_KIND_LABELS[job.originKind] ?? job.originKind} · {job.originId}
                  </td>
                  <td className="border-b border-line px-3 py-2.5 text-xs text-fg-muted">
                    {job.memoryStatus === undefined ? '—' : MEMORY_STATUS_LABELS[job.memoryStatus]}
                  </td>
                  <td className="border-b border-line px-3 py-2.5 tabular-nums text-xs text-fg-muted">{job.candidateIds.length}</td>
                  <td className="border-b border-line px-3 py-2.5 tabular-nums text-xs text-fg-muted">{job.createdAt}</td>
                  <td className="border-b border-line px-3 py-2.5 text-right">
                    <span className="text-xs text-fg-subtle">点行展开</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {status === 'ready' && hasMore ? (
        <button type="button" className={`${CTL_SECONDARY} self-start text-xs`} onClick={() => void loadMore(gateway)}>
          加载更多任务
        </button>
      ) : null}
      {selectedId !== undefined && detailId === selectedId ? (
        <MemoryExtractionDetail extractionId={selectedId} onClose={() => { setSelectedId(undefined); clearDetail() }} onOpenProposals={onOpenProposals} />
      ) : null}
      {creating ? <MemoryExtractionCreateDialog onClose={() => setCreating(false)} /> : null}
    </div>
  )
}
