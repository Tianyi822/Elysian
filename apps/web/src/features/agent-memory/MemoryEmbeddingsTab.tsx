import { useEffect, useRef, useState } from 'react'
import type { AgentEmbeddingProfile } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentRunStatusTag } from '../../components/agent/AgentStatusTag'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { useSilentPolling } from '../../components/agent/useSilentPolling'
import { useNotificationStore } from '../../stores/notificationStore'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { Pencil, Plus, RefreshCw } from '../../components/icons'
import { StatusTag } from '../../components/StatusTag'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { formatUsageTokens, MEMORY_EMBEDDING_PURPOSE_LABELS } from './memoryLabels'
import { MemoryEmbeddingFormDialog } from './MemoryEmbeddingFormDialog'

/*
 * 「Embedding 与索引」页签：上半是配置 CRUD（凭据只写）＋当前空间的索引状态与
 * 重建；下半是用量分页（不携带正文、查询原文或向量，保留 30 天）。重建带
 * requestId（withRequestId 幂等），202 后轮询任务至终态再回读索引状态。
 */
export function MemoryEmbeddingsTab({ spaceId }: { spaceId?: string }) {
  const gateway = useGateway()
  const profilesStatus = useAgentMemoryStore((state) => state.profilesStatus)
  const profilesReloading = useAgentMemoryStore((state) => state.profilesReloading)
  const profiles = useAgentMemoryStore((state) => state.profiles)
  const profilesError = useAgentMemoryStore((state) => state.profilesErrorMessage)
  const loadProfiles = useAgentMemoryStore((state) => state.loadProfiles)
  const indexState = useAgentMemoryStore((state) => state.indexStatusState)
  const indexReloading = useAgentMemoryStore((state) => state.indexReloading)
  const indexStatuses = useAgentMemoryStore((state) => state.indexStatuses)
  const indexError = useAgentMemoryStore((state) => state.indexErrorMessage)
  const loadIndexStatus = useAgentMemoryStore((state) => state.loadIndexStatus)
  const rebuildIndex = useAgentMemoryStore((state) => state.rebuildIndex)
  const requestsStatus = useAgentMemoryStore((state) => state.requestsStatus)
  const requestsReloading = useAgentMemoryStore((state) => state.requestsReloading)
  const requests = useAgentMemoryStore((state) => state.requests)
  const requestsHasMore = useAgentMemoryStore((state) => state.requestsHasMore)
  const requestsError = useAgentMemoryStore((state) => state.requestsErrorMessage)
  const loadRequests = useAgentMemoryStore((state) => state.loadEmbeddingRequests)
  const loadMoreRequests = useAgentMemoryStore((state) => state.loadMoreEmbeddingRequests)
  const [editing, setEditing] = useState<AgentEmbeddingProfile | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [rebuildJobId, setRebuildJobId] = useState<string | undefined>(undefined)
  const { submitting, withRequestId, newRequestId } = useInFlightSubmit()
  const rebuildInput = useRef<string | undefined>(undefined)

  useEffect(() => {
    void loadProfiles(gateway)
    void loadRequests(gateway)
  }, [gateway, loadProfiles, loadRequests])

  useEffect(() => {
    if (spaceId !== undefined) void loadIndexStatus(gateway, spaceId)
  }, [gateway, spaceId, loadIndexStatus])

  const rebuildActive = useAgentMemoryStore((state) =>
    state.detailJob !== undefined && state.detailJob.id === rebuildJobId && ['queued', 'running'].includes(state.detailJob.status))
  const rebuildJob = useAgentMemoryStore((state) => (state.detailJob?.id === rebuildJobId ? state.detailJob : undefined))
  const loadExtractionDetail = useAgentMemoryStore((state) => state.loadExtractionDetail)

  const { degraded } = useSilentPolling(
    async (signal) => {
      if (rebuildJobId !== undefined) {
        await loadExtractionDetail(gateway, rebuildJobId, { silent: true, signal })
        if (signal.aborted) return
        if (useAgentMemoryStore.getState().detailJob?.status === 'succeeded' && spaceId !== undefined) {
          await loadIndexStatus(gateway, spaceId, { silent: true, signal })
        }
      }
    },
    { intervalMs: 3_000, enabled: rebuildActive },
  )

  const submitRebuild = async (profileId: string, profileRevision: number) => {
    if (spaceId === undefined) return
    const inputKey = `${spaceId}:${profileId}:${profileRevision}`
    if (rebuildInput.current !== inputKey) {
      rebuildInput.current = inputKey
      newRequestId()
    }
    await withRequestId(async (requestId) => {
      try {
        const job = await rebuildIndex(gateway, spaceId, { requestId, profileId, profileRevision })
        setRebuildJobId(job.id)
        await loadExtractionDetail(gateway, job.id, { silent: true })
      } catch (error) {
        useNotificationStore.getState().notify({
          tone: 'danger',
          message: error instanceof Error && error.message !== '' ? error.message : '提交索引重建失败',
        })
      }
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {degraded ? <p role="status" className="text-xs text-fg-muted">连接中断，正在重试…</p> : null}
      <section aria-label="Embedding 配置" className="busy-host relative flex flex-col gap-3 panel-surface p-4">
        <BusyVeil busy={profilesReloading} />
        <header className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Embedding 配置</h3>
          <span className="ml-auto inline-flex items-center gap-2">
            <RefreshButton label="刷新配置列表" onPress={() => void loadProfiles(gateway)} busy={profilesReloading} />
            <button type="button" className={`${CTL_PRIMARY} text-xs`} onClick={() => setCreating(true)}>
              <span className="inline-flex items-center gap-1"><Plus aria-hidden size={13} />新建配置</span>
            </button>
          </span>
        </header>
        {profilesStatus === 'loading' || profilesStatus === 'idle' ? <LoadingState label="正在读取 Embedding 配置…" /> : null}
        {profilesStatus === 'error' ? <ErrorState description={profilesError} onRetry={() => void loadProfiles(gateway)} /> : null}
        {profilesStatus === 'ready' && profiles.length === 0 ? (
          <EmptyState title="尚未配置 Embedding" description="没有配置时搜索使用 SQLite 中文双字全文回落，不会失败。" />
        ) : null}
        {profilesStatus === 'ready' && profiles.length > 0 ? (
          <div role="region" aria-label="Embedding 配置列表" className="overflow-x-auto">
            <table className="w-full min-w-[44rem] table-fixed border-separate border-spacing-0 text-left text-sm">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[26%]" />
                <col className="w-[16%]" />
                <col className="w-[10%]" />
                <col className="w-[12%]" />
                <col className="w-[14%]" />
              </colgroup>
              <thead>
                <tr>
                  {['名称', '服务地址 / 模型', '维度', '启用', '凭据', '修订'].map((label) => (
                    <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2 text-xs font-medium text-fg-muted">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => (
                  <tr key={profile.id} className="whitespace-nowrap hover:bg-surface-raised">
                    <td className="border-b border-line px-3 py-2">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-medium text-fg" title={profile.name}>{profile.name}</span>
                        <button
                          type="button"
                          aria-label={`编辑配置「${profile.name}」`}
                          title={`编辑配置「${profile.name}」`}
                          onClick={() => setEditing(profile)}
                          className="rounded-lg border border-line p-1.5 text-fg-muted transition-colors hover:text-fg"
                        >
                          <Pencil aria-hidden size={12} />
                        </button>
                      </span>
                    </td>
                    <td className="border-b border-line px-3 py-2 font-mono text-xs text-fg-muted">
                      <span className="block truncate" title={`${profile.baseUrl} · ${profile.model}`}>{profile.baseUrl}</span>
                      <span className="block truncate text-fg-subtle">{profile.model}</span>
                    </td>
                    <td className="border-b border-line px-3 py-2 tabular-nums text-fg-muted">{profile.dimensions}</td>
                    <td className="border-b border-line px-3 py-2">{profile.active ? <StatusTag label="启用" tone="success" /> : <StatusTag label="停用" tone="neutral" />}</td>
                    <td className="border-b border-line px-3 py-2 text-xs text-fg-muted">{profile.hasCredential ? '已保存（不回显）' : '未设置'}</td>
                    <td className="border-b border-line px-3 py-2 tabular-nums text-fg-muted">{profile.revision}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section aria-label="空间索引状态" className="busy-host relative flex flex-col gap-3 panel-surface p-4">
        <header className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">空间索引</h3>
          {spaceId === undefined ? <span className="text-xs text-fg-subtle">先在左侧选择空间</span> : null}
          <span className="ml-auto">
            <RefreshButton label="刷新索引状态" onPress={() => spaceId !== undefined && void loadIndexStatus(gateway, spaceId)} busy={indexReloading} />
          </span>
        </header>
        {indexState === 'loading' || indexState === 'idle' ? <LoadingState label="正在读取索引状态…" /> : null}
        {indexState === 'error' ? <ErrorState description={indexError} onRetry={() => spaceId !== undefined && void loadIndexStatus(gateway, spaceId)} /> : null}
        {indexState === 'ready' && indexStatuses.length === 0 ? (
          <EmptyState title="没有 Embedding 配置" description="先创建配置，再对空间重建索引。" />
        ) : null}
        {indexState === 'ready' && indexStatuses.length > 0 ? (
          <div className="flex flex-col gap-2">
            {indexStatuses.map((row) => (
              <div key={row.profile.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2">
                <span className="text-sm text-fg">{row.profile.name}</span>
                {row.status === 'ready'
                  ? <StatusTag label="ready" tone="success" />
                  : <StatusTag label="stale" tone="warning" />}
                <span className="text-xs tabular-nums text-fg-muted">
                  已索引 {row.indexedPages}/{row.pages} 页
                </span>
                {row.status === 'stale' ? (
                  <span className="text-xs text-fg-subtle">搜索继续使用文本回落，不影响可用性</span>
                ) : null}
                <span className="ml-auto">
                  <button
                    type="button"
                    className={`${CTL_SECONDARY} text-xs`}
                    disabled={submitting || spaceId === undefined}
                    onClick={() => void submitRebuild(row.profile.id, row.profile.revision)}
                  >
                    <span className="inline-flex items-center gap-1"><RefreshCw aria-hidden size={12} />重建索引</span>
                  </button>
                </span>
              </div>
            ))}
            {rebuildJob !== undefined ? (
              <p role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-fg-muted">
                <AgentRunStatusTag status={rebuildJob.status} />
                重建任务 <span className="font-mono">{rebuildJob.id}</span>
                {['queued', 'running'].includes(rebuildJob.status) ? '执行中，完成后自动回读索引状态…' : '已结束，索引状态已回读。'}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-label="Embedding 用量" className="flex flex-col gap-3 panel-surface p-4">
        <header className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Embedding 用量</h3>
          <span className="ml-auto">
            <RefreshButton label="刷新用量" onPress={() => void loadRequests(gateway)} busy={requestsReloading} />
          </span>
        </header>
        <p className="text-xs leading-5 text-fg-muted">
          用量账本不含正文、查询原文与向量，仅记录字节数、摘要与 token 估算；记录保留 30 天，供应商未报告的用量显示「未知」。
        </p>
        {requestsStatus === 'loading' || requestsStatus === 'idle' ? <LoadingState label="正在读取用量…" /> : null}
        {requestsStatus === 'error' ? <ErrorState description={requestsError} onRetry={() => void loadRequests(gateway)} /> : null}
        {requestsStatus === 'ready' && requests.length === 0 ? <EmptyState title="暂无用量记录" /> : null}
        {requestsStatus === 'ready' && requests.length > 0 ? (
          <>
            <div role="region" aria-label="Embedding 用量列表" className="overflow-x-auto">
              <table className="w-full min-w-[46rem] table-fixed border-separate border-spacing-0 text-left text-sm">
                <colgroup>
                  <col className="w-[18%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[14%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[20%]" />
                </colgroup>
                <thead>
                  <tr>
                    {['请求', '用途', '状态', '输入字节', '估算 token', '实际 token', '时间'].map((label) => (
                      <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2 text-xs font-medium text-fg-muted">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {requests.map((item) => (
                    <tr key={item.id} className="whitespace-nowrap">
                      <td className="border-b border-line px-3 py-2 font-mono text-xs text-fg">{item.id}</td>
                      <td className="border-b border-line px-3 py-2 text-xs text-fg-muted">{MEMORY_EMBEDDING_PURPOSE_LABELS[item.purpose]}</td>
                      <td className="border-b border-line px-3 py-2"><AgentRunStatusTag status={item.status} /></td>
                      <td className="border-b border-line px-3 py-2 tabular-nums text-xs text-fg-muted">{item.inputBytes}</td>
                      <td className="border-b border-line px-3 py-2 tabular-nums text-xs text-fg-muted">{formatUsageTokens(item.estimatedTokens)}</td>
                      <td className="border-b border-line px-3 py-2 tabular-nums text-xs text-fg-muted">{formatUsageTokens(item.usage.promptTokens)}</td>
                      <td className="border-b border-line px-3 py-2 tabular-nums text-xs text-fg-muted">{item.startedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {requestsHasMore ? (
              <button type="button" className={`${CTL_SECONDARY} self-start text-xs`} onClick={() => void loadMoreRequests(gateway)}>
                加载更多用量
              </button>
            ) : null}
          </>
        ) : null}
      </section>

      {creating ? <MemoryEmbeddingFormDialog onClose={() => setCreating(false)} /> : null}
      {editing !== undefined ? <MemoryEmbeddingFormDialog profile={editing} onClose={() => setEditing(undefined)} /> : null}
    </div>
  )
}
