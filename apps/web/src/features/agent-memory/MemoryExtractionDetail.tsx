import { useEffect } from 'react'
import { Link } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentRunStatusTag } from '../../components/agent/AgentStatusTag'
import { useSilentPolling } from '../../components/agent/useSilentPolling'
import { CTL_SECONDARY } from '../../components/formControl'
import { LoadingState, ErrorState } from '../../components/states/StateViews'
import { useAgentMemoryStore, extractionIsActive } from '../../stores/agentMemoryStore'
import { formatUsageTokens, MEMORY_JOB_KIND_LABELS, MEMORY_ORIGIN_KIND_LABELS, MEMORY_STATUS_LABELS } from './memoryLabels'
import { MemoryOriginLink, MemoryPageSourceLink } from './MemorySourceLinks'

/*
 * 提炼任务详情：非终态（queued/running）经 useSilentPolling 每 3 秒静默回读，
 * 终态即停；interrupted/failed 不提供重试（服务端不自动重跑，需重新提交新任务）。
 */
export function MemoryExtractionDetail({
  extractionId,
  onClose,
  onOpenProposals,
}: {
  extractionId: string
  onClose(): void
  onOpenProposals(proposalId?: string, spaceId?: string): void
}) {
  const gateway = useGateway()
  const status = useAgentMemoryStore((state) => state.detailStatus)
  const job = useAgentMemoryStore((state) => state.detailJob)
  const errorMessage = useAgentMemoryStore((state) => state.detailErrorMessage)
  const loadDetail = useAgentMemoryStore((state) => state.loadExtractionDetail)

  useEffect(() => {
    void loadDetail(gateway, extractionId)
  }, [gateway, extractionId, loadDetail])

  const active = extractionIsActive(status === 'ready' ? job : undefined)
  const { degraded } = useSilentPolling(
    async (signal) => {
      await loadDetail(gateway, extractionId, { silent: true, signal })
    },
    { intervalMs: 3_000, enabled: active },
  )

  return (
    <section aria-label={`提炼任务详情 ${extractionId}`} className="panel-surface p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono text-sm font-semibold">{extractionId}</h3>
        {job !== undefined ? <AgentRunStatusTag status={job.status} /> : null}
        <button type="button" className={`${CTL_SECONDARY} ml-auto text-xs`} onClick={onClose}>收起详情</button>
      </header>
      {degraded ? (
        <p role="status" className="mt-2 text-xs text-fg-muted">连接中断，正在重试…</p>
      ) : null}
      {active ? (
        <p role="status" className="mt-2 text-xs text-fg-muted">
          任务执行中，每 3 秒静默回读服务端状态；此面板不提供进度百分比。
        </p>
      ) : null}
      {status === 'loading' ? <div className="mt-3"><LoadingState label="正在读取任务详情…" /></div> : null}
      {status === 'error' ? (
        <div className="mt-3">
          <ErrorState description={errorMessage} onRetry={() => void loadDetail(gateway, extractionId)} />
        </div>
      ) : null}
      {status === 'ready' && job !== undefined ? (
        <div className="mt-3 flex flex-col gap-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
            <div><dt className="text-fg-subtle">任务种类</dt><dd>{MEMORY_JOB_KIND_LABELS[job.kind]}</dd></div>
            <div><dt className="text-fg-subtle">来源</dt><dd>{MEMORY_ORIGIN_KIND_LABELS[job.originKind] ?? job.originKind} · <MemoryOriginLink kind={job.originKind} id={job.originId} runId={job.runId} workflowId={job.workflowId} /></dd></div>
            <div><dt className="text-fg-subtle">空间</dt><dd className="font-mono">{job.spaceId}</dd></div>
            {job.memoryStatus !== undefined ? (
              <div><dt className="text-fg-subtle">记忆状态</dt><dd>{MEMORY_STATUS_LABELS[job.memoryStatus]}</dd></div>
            ) : null}
            {job.runId !== undefined ? <div><dt className="text-fg-subtle">运行</dt><dd className="font-mono"><Link className="text-info underline underline-offset-2" to={`/agent/runs?runId=${encodeURIComponent(job.runId)}`}>{job.runId}</Link></dd></div> : null}
            {job.workflowId !== undefined ? <div><dt className="text-fg-subtle">工作流</dt><dd className="font-mono"><Link className="text-info underline underline-offset-2" to={`/agent/workflows?view=instances&instanceId=${encodeURIComponent(job.workflowId)}`}>{job.workflowId}</Link></dd></div> : null}
            <div><dt className="text-fg-subtle">模型</dt><dd>{job.model.name !== '' ? `${job.model.name}（${job.model.model}）` : '（索引任务不带模型）'}</dd></div>
            <div><dt className="text-fg-subtle">估算 token</dt><dd className="tabular-nums">{formatUsageTokens(job.estimatedTokens)}</dd></div>
            <div><dt className="text-fg-subtle">实际 token</dt><dd className="tabular-nums">{formatUsageTokens(job.usage.totalTokens ?? job.usage.promptTokens)}</dd></div>
            <div><dt className="text-fg-subtle">创建于</dt><dd className="tabular-nums">{job.createdAt}</dd></div>
            {job.endedAt !== undefined ? <div><dt className="text-fg-subtle">结束于</dt><dd className="tabular-nums">{job.endedAt}</dd></div> : null}
          </dl>
          {job.error !== undefined ? (
            <p role="alert" className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-danger">
              {job.error.message}（code：{job.error.code}）{job.status === 'interrupted' ? '；面板不会自动重跑该任务。' : ''}
            </p>
          ) : null}
          {job.embeddingProfile !== undefined ? (
            <p className="text-xs text-fg-muted">
              固定 Embedding：{job.embeddingProfile.name}（修订 {job.embeddingProfile.revision}，{job.embeddingProfile.dimensions} 维）
            </p>
          ) : null}
          <div>
            <p className="text-xs text-fg-muted">候选（{job.candidateIds.length}）</p>
            {job.candidateIds.length === 0 ? (
              <p className="mt-1 text-xs text-fg-subtle">尚无候选；任务成功后产出，失败则为空。</p>
            ) : (
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {job.candidateIds.map((id) => (
                  <button key={id} type="button" className="rounded border border-line px-1.5 py-0.5 font-mono text-xs text-fg-muted hover:text-fg" onClick={() => onOpenProposals(id, job.spaceId)}>
                    {id}
                  </button>
                ))}
                <button type="button" className="text-xs text-fg-muted underline underline-offset-2 hover:text-fg" onClick={() => onOpenProposals(undefined, job.spaceId)}>
                  前往候选页签
                </button>
              </div>
            )}
          </div>
          {job.sources.length > 0 ? (
            <div className="text-xs text-fg-muted"><p>来源修订</p><ul className="mt-1 space-y-1">{job.sources.map((source) => (
              <li key={`${source.pageId}:${source.revision}`} className="break-all font-mono"><MemoryPageSourceLink source={source} spaceId={job.spaceId} />:r{source.revision}@{source.digest}</li>
            ))}</ul></div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
