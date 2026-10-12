import { useEffect } from 'react'
import { useSearchParams } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { AgentUnavailableState } from '../../components/agent/AgentUnavailableState'
import { CTL_CHIP, CTL_GROUP } from '../../components/formControl'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { AGENT_MEMORY_TABS, type AgentMemoryTab } from './memoryLabels'
import { MemorySpacesPanel } from './MemorySpacesPanel'
import { MemoryPagesTab } from './MemoryPagesTab'
import { MemorySearchTab } from './MemorySearchTab'
import { MemoryProposalsTab } from './MemoryProposalsTab'
import { MemoryExtractionsTab } from './MemoryExtractionsTab'
import { MemoryEmbeddingsTab } from './MemoryEmbeddingsTab'
import { MemoryChecksTab } from './MemoryChecksTab'

/**
 * 长期记忆页（/agent/memory，所有权归 agent-memory 模块）。
 * 深链契约（模块内导航只许查询参数，不得新增路由）：
 *   /agent/memory?spaceId=<spaceId>&pageId=<pageId>&proposalId=<proposalId>&tab=pages|search|proposals|extractions|embeddings|checks
 * 左侧空间列表（business/global，全局唯一）＋右侧六页签；导入/导出在「页面」页签内，
 * 索引状态与重建在「Embedding 与索引」页签内。本页标题与引导文案与工作台的
 * 「任务工作记忆」明确分域：长期记忆＝跨会话 Wiki，工作记忆＝Task 内、整理函数维护。
 */
export function AgentMemoryPage() {
  const gateway = useGateway()
  const status = useAgentRuntimeStore((state) => state.status)
  const info = useAgentRuntimeStore((state) => state.info)
  const errorMessage = useAgentRuntimeStore((state) => state.errorMessage)
  const loadRuntime = useAgentRuntimeStore((state) => state.load)
  const spaces = useAgentMemoryStore((state) => state.spaces)
  const loadSpaces = useAgentMemoryStore((state) => state.loadSpaces)

  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab: AgentMemoryTab = AGENT_MEMORY_TABS.some((item) => item.value === tabParam)
    ? (tabParam as AgentMemoryTab)
    : 'pages'
  const spaceIdParam = searchParams.get('spaceId')
  const pageIdParam = searchParams.get('pageId')
  const proposalIdParam = searchParams.get('proposalId')
  const selectedSpaceId = spaceIdParam !== null && spaces.some((space) => space.id === spaceIdParam)
    ? spaceIdParam
    : spaces[0]?.id

  useEffect(() => {
    void loadRuntime(gateway)
  }, [gateway, loadRuntime])

  useEffect(() => {
    if (status === 'ready' && info?.available) void loadSpaces(gateway)
  }, [status, info, gateway, loadSpaces])

  if (status === 'loading' || status === 'idle') {
    return <div className="panel-surface p-6 text-sm text-fg-muted" role="status">正在确认 Ely 运行时状态…</div>
  }
  if (status === 'error') {
    return (
      <div role="alert" className="panel-surface p-6 text-sm">
        <p className="font-medium">读取 Agent 运行时报告失败</p>
        <p className="mt-1 text-xs text-fg-muted">{errorMessage}</p>
        <button type="button" className="mt-3 rounded-lg border border-line px-3 py-1.5 text-xs" onClick={() => void loadRuntime(gateway)}>
          重试
        </button>
      </div>
    )
  }
  if (info !== undefined && !info.available) {
    return <AgentUnavailableState reason={info.reason} worker={info.worker} storage={info.storage} />
  }

  const setParam = (next: { tab?: AgentMemoryTab; spaceId?: string; pageId?: string | null; proposalId?: string | null }) => {
    const params = new URLSearchParams()
    const tabValue = next.tab ?? tab
    const spaceValue = next.spaceId !== undefined ? next.spaceId : selectedSpaceId
    const pageValue = next.pageId !== undefined ? next.pageId : next.spaceId !== undefined || next.tab !== undefined ? null : pageIdParam
    const proposalValue = next.proposalId !== undefined ? next.proposalId : next.spaceId !== undefined || next.tab !== undefined ? null : proposalIdParam
    if (tabValue !== 'pages') params.set('tab', tabValue)
    if (spaceValue !== undefined) params.set('spaceId', spaceValue)
    if (pageValue !== null && pageValue !== undefined && pageValue !== '') params.set('pageId', pageValue)
    if (tabValue === 'proposals' && proposalValue !== null && proposalValue !== undefined && proposalValue !== '') params.set('proposalId', proposalValue)
    setSearchParams(params, { replace: true })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="长期记忆页签" className={CTL_GROUP}>
          {AGENT_MEMORY_TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={item.value === tab}
              className={CTL_CHIP}
              onClick={() => setParam({ tab: item.value, pageId: null })}
            >
              {item.label}
            </button>
          ))}
        </div>
        {!isDockerRuntime() ? (
          <span role="status" className="text-xs text-fg-subtle">演示数据</span>
        ) : null}
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        <MemorySpacesPanel selectedSpaceId={selectedSpaceId} onSelect={(next) => setParam({ spaceId: next, pageId: null })} />
        <div className="min-w-0 flex-1">
          {tab === 'pages' && selectedSpaceId !== undefined ? (
            <MemoryPagesTab
              spaceId={selectedSpaceId}
              selectedPageId={pageIdParam ?? undefined}
              onSelectPage={(pageId) => setParam({ pageId: pageId ?? null })}
            />
          ) : null}
          {tab === 'search' && selectedSpaceId !== undefined ? <MemorySearchTab spaceId={selectedSpaceId} onOpenPage={(pageId) => setParam({ tab: 'pages', pageId })} /> : null}
          {tab === 'proposals' ? (
            <MemoryProposalsTab
              spaceId={selectedSpaceId}
              selectedProposalId={proposalIdParam ?? undefined}
              onOpenPage={(pageId, spaceId) => setParam({ tab: 'pages', spaceId, pageId })}
            />
          ) : null}
          {tab === 'extractions' ? (
            <MemoryExtractionsTab onOpenProposals={(proposalId, spaceId) => setParam({ tab: 'proposals', spaceId, pageId: null, proposalId: proposalId ?? null })} />
          ) : null}
          {tab === 'embeddings' ? <MemoryEmbeddingsTab spaceId={selectedSpaceId} /> : null}
          {tab === 'checks' ? <MemoryChecksTab spaceId={selectedSpaceId} /> : null}
          {(tab === 'pages' || tab === 'search') && selectedSpaceId === undefined ? (
            <div className="panel-surface p-6 text-sm text-fg-muted" role="status">
              先在左侧创建或选择一个记忆空间。
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
