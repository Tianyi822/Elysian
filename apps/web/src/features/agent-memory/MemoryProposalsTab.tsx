import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { AgentMemoryProposalStatus } from '@elysian/contracts'
import { AGENT_MEMORY_PROPOSAL_STATUSES, AGENT_MEMORY_PROPOSAL_STATUS_LABELS } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { CTL_CHIP, CTL_DANGER, CTL_GROUP, CTL_PRIMARY } from '../../components/formControl'
import { StatusTag } from '../../components/StatusTag'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { useNotificationStore } from '../../stores/notificationStore'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { MEMORY_ORIGIN_KIND_LABELS, MEMORY_PROPOSAL_INVALIDATED_NOTE, proposalTargetLabel } from './memoryLabels'
import { MemoryOriginLink, MemoryPageSourceLink } from './MemorySourceLinks'

/*
 * 「提炼候选」页签：status 过滤＋决定。批准即发布为页面修订（服务端事务），
 * 拒绝后候选终态；决定无 requestId（单飞锁＋服务端同决定幂等）。
 * invalidated 行不提供决定按钮，只给关联提示。
 */

function notifyFailure(error: unknown, fallback: string): void {
  useNotificationStore.getState().notify({
    tone: 'danger',
    message: error instanceof Error && error.message !== '' ? error.message : fallback,
  })
}

const STATUS_TONES: Record<AgentMemoryProposalStatus, 'warning' | 'success' | 'danger' | 'neutral'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  invalidated: 'neutral',
}

export function MemoryProposalsTab({
  spaceId,
  selectedProposalId,
  onOpenPage,
}: {
  spaceId?: string
  selectedProposalId?: string
  onOpenPage(pageId: string, spaceId: string): void
}) {
  const gateway = useGateway()
  const status = useAgentMemoryStore((state) => state.proposalsStatus)
  const reloading = useAgentMemoryStore((state) => state.proposalsReloading)
  const proposals = useAgentMemoryStore((state) => state.proposals)
  const filter = useAgentMemoryStore((state) => state.proposalsFilter)
  const errorMessage = useAgentMemoryStore((state) => state.proposalsErrorMessage)
  const load = useAgentMemoryStore((state) => state.loadProposals)
  const decide = useAgentMemoryStore((state) => state.decideProposal)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [deciding, setDeciding] = useState<string | undefined>(undefined)
  const selectedRef = useRef<HTMLLIElement>(null)

  const statusFilter = filter.status

  useEffect(() => {
    void load(gateway, { spaceId })
  }, [gateway, spaceId, load])

  useEffect(() => {
    if (selectedProposalId !== undefined && proposals.some((item) => item.id === selectedProposalId)) {
      selectedRef.current?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [selectedProposalId, proposals])

  return (
    <div className="busy-host relative flex flex-col gap-3">
      <BusyVeil busy={reloading} />
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="候选状态过滤" className={CTL_GROUP}>
          <button
            type="button"
            aria-pressed={statusFilter === undefined}
            className={CTL_CHIP}
            onClick={() => void load(gateway, { spaceId })}
          >
            全部
          </button>
          {AGENT_MEMORY_PROPOSAL_STATUSES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={statusFilter === value}
              className={CTL_CHIP}
              onClick={() => void load(gateway, { spaceId, status: value })}
            >
              {AGENT_MEMORY_PROPOSAL_STATUS_LABELS[value]}
            </button>
          ))}
        </div>
        <span className="ml-auto">
          <RefreshButton label="刷新候选列表" onPress={() => void load(gateway)} busy={reloading} />
        </span>
      </div>

      {status === 'loading' || status === 'idle' ? <LoadingState label="正在读取提炼候选…" /> : null}
      {status === 'error' ? <ErrorState description={errorMessage} onRetry={() => void load(gateway)} /> : null}
      {status === 'ready' && proposals.length === 0 ? (
        <EmptyState title="没有符合条件的候选" description="提炼任务完成后会在这里产出待确认的页面候选。" />
      ) : null}
      {status === 'ready' && selectedProposalId !== undefined && !proposals.some((item) => item.id === selectedProposalId) ? (
        <p role="status" className="text-xs text-fg-muted">未在当前空间找到候选 {selectedProposalId}。</p>
      ) : null}
      {status === 'ready' ? (
        <ul className="flex flex-col gap-2">
          {proposals.map((proposal) => {
            const targetPageId = proposal.pageId
            return (
            <li key={proposal.id} ref={proposal.id === selectedProposalId ? selectedRef : undefined} aria-current={proposal.id === selectedProposalId ? 'true' : undefined} className={`panel-surface p-3 ${proposal.id === selectedProposalId ? 'ring-2 ring-info' : ''}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-fg-muted">{proposal.id}</span>
                <StatusTag label={AGENT_MEMORY_PROPOSAL_STATUS_LABELS[proposal.status]} tone={STATUS_TONES[proposal.status]} />
                <span className="text-sm font-medium text-fg">{proposal.page.title}</span>
                <span className="font-mono text-xs text-fg-muted">{proposalTargetLabel(proposal)}</span>
                <span className="text-xs text-fg-subtle">
                  来源：{MEMORY_ORIGIN_KIND_LABELS[proposal.originKind] ?? proposal.originKind} · <MemoryOriginLink kind={proposal.originKind} id={proposal.originId} />
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                  {targetPageId !== undefined ? (
                    <button type="button" className={`${CTL_CHIP} text-xs`} onClick={() => onOpenPage(targetPageId, proposal.spaceId)}>
                      查看页面
                    </button>
                  ) : null}
                  {proposal.status === 'pending' ? (
                    <>
                      <button
                        type="button"
                        className={`${CTL_PRIMARY} text-xs`}
                        disabled={submitting && deciding === proposal.id}
                        onClick={() => {
                          setDeciding(proposal.id)
                          void inFlightOnly(async () => {
                            try {
                              await decide(gateway, proposal.id, { decision: 'approved' })
                            } catch (error) {
                              notifyFailure(error, '批准候选失败')
                            }
                          })
                        }}
                      >
                        批准并发布
                      </button>
                      <button
                        type="button"
                        className={`${CTL_DANGER} text-xs`}
                        disabled={submitting && deciding === proposal.id}
                        onClick={() => {
                          setDeciding(proposal.id)
                          void inFlightOnly(async () => {
                            try {
                              await decide(gateway, proposal.id, { decision: 'rejected' })
                            } catch (error) {
                              notifyFailure(error, '拒绝候选失败')
                            }
                          })
                        }}
                      >
                        拒绝
                      </button>
                    </>
                  ) : null}
                </span>
              </div>
              {proposal.status === 'invalidated' ? (
                <p role="status" className="mt-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-fg-muted">
                  {MEMORY_PROPOSAL_INVALIDATED_NOTE}
                </p>
              ) : null}
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-line bg-surface p-2 font-mono text-xs whitespace-pre-wrap break-all text-fg-muted">
                {proposal.page.markdown}
              </pre>
              {proposal.page.evidence?.length ? (
                <div className="mt-2 text-xs text-fg-muted"><span className="font-medium">证据：</span>{proposal.page.evidence.map((item) => <p key={item.id} className="mt-1 break-all">{item.kind} · {item.text} · {item.digest}{item.originalCleared ? ' · 原文已清理' : ''}{item.runId ? <> · <Link className="text-info underline underline-offset-2" to={`/agent/runs?runId=${encodeURIComponent(item.runId)}`}>运行 {item.runId}</Link></> : null}</p>)}</div>
              ) : null}
              {proposal.page.sources?.length ? (
                <div className="mt-2 text-xs text-fg-muted"><span className="font-medium">来源：</span>{proposal.page.sources.map((item) => <p key={`${item.pageId}:${item.revision}`} className="mt-1 break-all font-mono"><MemoryPageSourceLink source={item} spaceId={proposal.spaceId} /> · r{item.revision} · {item.digest}</p>)}</div>
              ) : null}
              <p className="mt-1.5 text-xs text-fg-subtle">
                提出于 {proposal.createdAt}
                {proposal.decidedAt !== undefined ? ` · 决定于 ${proposal.decidedAt}` : ''}
                {proposal.page.expectedRevision !== undefined ? ` · 基准修订 ${proposal.page.expectedRevision}` : ''}
              </p>
            </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
