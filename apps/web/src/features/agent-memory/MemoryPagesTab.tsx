import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { AgentMemoryPage } from '@elysian/contracts'
import { AGENT_MEMORY_PAGE_KIND_LABELS } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { CTL_CHIP, CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { History, Pencil, Plus, Trash2, Upload, Download } from '../../components/icons'
import { StatusTag } from '../../components/StatusTag'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { MEMORY_PAGE_STATUS_LABELS, MEMORY_PAGE_STATUS_TONES } from './memoryLabels'
import { MemoryPageFormDialog } from './MemoryPageFormDialog'
import { MemoryWithdrawDialog } from './MemoryWithdrawDialog'
import { MemoryRevisionDialog } from './MemoryRevisionDialog'
import { MemoryImportDialog } from './MemoryImportDialog'
import { MemoryExportDialog } from './MemoryExportDialog'
import { MemoryPageSourceLink } from './MemorySourceLinks'

/*
 * 「页面」页签：当前空间的 Wiki 页面列表。kind 十类、status、ExpiresAt、tags 全量
 * 呈现；建页/改页/撤回均无 requestId（单飞锁），expectedRevision 随 PUT Input 体或
 * DELETE JSON body 提交。含 includeWithdrawn 开关、导入与导出预览入口。
 */
export function MemoryPagesTab({
  spaceId,
  selectedPageId,
  onSelectPage,
}: {
  spaceId: string
  selectedPageId?: string
  onSelectPage(pageId: string | undefined): void
}) {
  const gateway = useGateway()
  const status = useAgentMemoryStore((state) => state.pagesStatus)
  const reloading = useAgentMemoryStore((state) => state.pagesReloading)
  const pages = useAgentMemoryStore((state) => state.pages)
  const errorMessage = useAgentMemoryStore((state) => state.pagesErrorMessage)
  const includeWithdrawn = useAgentMemoryStore((state) => state.includeWithdrawn)
  const load = useAgentMemoryStore((state) => state.loadPages)
  const setIncludeWithdrawn = useAgentMemoryStore((state) => state.setIncludeWithdrawn)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<AgentMemoryPage | undefined>(undefined)
  const [withdrawing, setWithdrawing] = useState<AgentMemoryPage | undefined>(undefined)
  const [revisions, setRevisions] = useState<AgentMemoryPage | undefined>(undefined)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)

  const selected = selectedPageId === undefined ? undefined : pages.find((page) => page.id === selectedPageId)

  useEffect(() => {
    void load(gateway, spaceId)
  }, [gateway, spaceId, load])

  return (
    <div className="busy-host relative flex flex-col gap-3">
      <BusyVeil busy={reloading} />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={includeWithdrawn}
          className={CTL_CHIP}
          onClick={() => void setIncludeWithdrawn(gateway, !includeWithdrawn)}
        >
          {includeWithdrawn ? '含已撤回' : '仅生效中'}
        </button>
        <button type="button" className={`${CTL_SECONDARY} text-xs`} onClick={() => setImporting(true)}>
          <span className="inline-flex items-center gap-1"><Upload aria-hidden size={13} />导入</span>
        </button>
        <button type="button" className={`${CTL_SECONDARY} text-xs`} onClick={() => setExporting(true)}>
          <span className="inline-flex items-center gap-1"><Download aria-hidden size={13} />导出预览</span>
        </button>
        <span className="ml-auto inline-flex items-center gap-2">
          <RefreshButton label="刷新页面列表" onPress={() => void load(gateway, spaceId)} busy={reloading} />
          <button type="button" className={`${CTL_PRIMARY} text-xs`} onClick={() => setCreating(true)}>
            <span className="inline-flex items-center gap-1"><Plus aria-hidden size={13} />新建页面</span>
          </button>
        </span>
      </div>

      {status === 'loading' || status === 'idle' ? <LoadingState label="正在读取 Wiki 页面…" /> : null}
      {status === 'error' ? <ErrorState description={errorMessage} onRetry={() => void load(gateway, spaceId)} /> : null}
      {status === 'ready' && pages.length === 0 ? (
        <EmptyState
          title={includeWithdrawn ? '该空间还没有页面' : '该空间没有生效中的页面'}
          description="新建页面或从 Markdown 导入，导入会先进入提炼候选。"
        />
      ) : null}
      {status === 'ready' && pages.length > 0 ? (
        <div role="region" aria-label="Wiki 页面列表" className="overflow-x-auto panel-surface">
          <table className="w-full min-w-[52rem] table-fixed border-separate border-spacing-0 text-left text-sm">
            <colgroup>
              <col className="w-[26%]" />
              <col className="w-[19%]" />
              <col className="w-[9%]" />
              <col className="w-[8%]" />
              <col className="w-[10%]" />
              <col className="w-[13%]" />
              <col className="w-[15%]" />
            </colgroup>
            <thead>
              <tr>
                {['标题', 'slug', '类型', '修订', '状态', '有效期', '标签'].map((label) => (
                  <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pages.map((page) => (
                <tr key={page.id} className={`whitespace-nowrap transition-colors hover:bg-surface-raised ${page.id === selectedPageId ? 'bg-surface-raised' : ''}`}>
                  <td className="border-b border-line px-3 py-2.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <button type="button" aria-expanded={page.id === selectedPageId} className="truncate text-left font-medium text-fg underline-offset-2 hover:underline" title={page.title} onClick={() => onSelectPage(page.id === selectedPageId ? undefined : page.id)}>{page.title}</button>
                      {page.status === 'withdrawn' ? <StatusTag label={MEMORY_PAGE_STATUS_LABELS.withdrawn} tone={MEMORY_PAGE_STATUS_TONES.withdrawn} /> : null}
                    </span>
                  </td>
                  <td className="border-b border-line px-3 py-2.5 font-mono text-xs text-fg-muted" title={page.slug}>{page.slug}</td>
                  <td className="border-b border-line px-3 py-2.5 text-fg-muted">{AGENT_MEMORY_PAGE_KIND_LABELS[page.kind]}</td>
                  <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">{page.revision}</td>
                  <td className="border-b border-line px-3 py-2.5">
                    <StatusTag label={MEMORY_PAGE_STATUS_LABELS[page.status]} tone={MEMORY_PAGE_STATUS_TONES[page.status]} />
                  </td>
                  <td className="border-b border-line px-3 py-2.5 tabular-nums text-xs text-fg-muted">
                    {page.expiresAt === undefined ? '长期' : <time dateTime={page.expiresAt}>{page.expiresAt}</time>}
                  </td>
                  <td className="border-b border-line px-3 py-2.5 text-xs text-fg-muted">
                    <span className="block truncate" title={(page.tags ?? []).join('，')}>{(page.tags ?? []).join('，')}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {selected !== undefined ? (
        <section aria-label={`页面详情 ${selected.title}`} className="panel-surface p-4">
          <header className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{selected.title}</h3>
            <StatusTag label={`修订 ${selected.revision}`} tone="info" />
            <StatusTag label={MEMORY_PAGE_STATUS_LABELS[selected.status]} tone={MEMORY_PAGE_STATUS_TONES[selected.status]} />
            <span className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                aria-label={`编辑页面「${selected.title}」`}
                title={`编辑页面「${selected.title}」`}
                className="rounded-lg border border-line p-2 text-fg-muted transition-colors hover:text-fg"
                onClick={() => setEditing(selected)}
              >
                <Pencil aria-hidden size={14} />
              </button>
              <button
                type="button"
                aria-label={`查看「${selected.title}」历史修订`}
                title={`查看「${selected.title}」历史修订`}
                className="rounded-lg border border-line p-2 text-fg-muted transition-colors hover:text-fg"
                onClick={() => setRevisions(selected)}
              >
                <History aria-hidden size={14} />
              </button>
              <button
                type="button"
                aria-label={`撤回页面「${selected.title}」`}
                title={`撤回页面「${selected.title}」`}
                className="rounded-lg border border-line p-2 text-fg-muted transition-colors hover:text-danger"
                onClick={() => setWithdrawing(selected)}
              >
                <Trash2 aria-hidden size={14} />
              </button>
            </span>
          </header>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-fg-muted sm:grid-cols-4">
            <div><dt className="text-fg-subtle">页面 ID</dt><dd className="font-mono">{selected.id}</dd></div>
            <div><dt className="text-fg-subtle">更新时间</dt><dd className="tabular-nums">{selected.updatedAt}</dd></div>
            <div><dt className="text-fg-subtle">证据</dt><dd className="tabular-nums">{selected.evidence.length}/32</dd></div>
            <div><dt className="text-fg-subtle">来源</dt><dd className="tabular-nums">{selected.sources.length}/64</dd></div>
          </dl>
          <pre className="mt-3 max-h-72 overflow-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs whitespace-pre-wrap break-all text-fg">
            {selected.markdown}
          </pre>
          {selected.evidence.length > 0 ? (
            <div className="mt-3 text-xs text-fg-muted">
              <h4 className="font-medium text-fg">证据</h4>
              <ul className="mt-1 space-y-1">{selected.evidence.map((item) => (
                <li key={item.id} className="break-all rounded border border-line p-2">
                  <span>{item.kind} · {item.text}</span>
                  <span className="mt-1 block font-mono text-fg-subtle">{item.runId ? <><Link className="text-info underline underline-offset-2" to={`/agent/runs?runId=${encodeURIComponent(item.runId)}`}>运行 {item.runId}</Link> · </> : null}{item.uri ? `${item.uri} · ` : ''}{item.digest}{item.originalCleared ? ' · 原文已清理' : ''}</span>
                </li>
              ))}</ul>
            </div>
          ) : null}
          {selected.sources.length > 0 ? (
            <div className="mt-3 text-xs text-fg-muted">
              <h4 className="font-medium text-fg">来源页面</h4>
              <ul className="mt-1 space-y-1">{selected.sources.map((item) => (
                <li key={`${item.pageId}:${item.revision}`} className="break-all rounded border border-line p-2 font-mono"><MemoryPageSourceLink source={item} spaceId={spaceId} /> · r{item.revision} · {item.digest}</li>
              ))}</ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {creating ? <MemoryPageFormDialog spaceId={spaceId} onClose={() => setCreating(false)} /> : null}
      {editing !== undefined ? <MemoryPageFormDialog spaceId={spaceId} page={editing} onClose={() => setEditing(undefined)} /> : null}
      {withdrawing !== undefined ? (
        <MemoryWithdrawDialog spaceId={spaceId} page={withdrawing} onClose={() => setWithdrawing(undefined)} />
      ) : null}
      {revisions !== undefined ? (
        <MemoryRevisionDialog spaceId={spaceId} page={revisions} onClose={() => setRevisions(undefined)} />
      ) : null}
      {importing ? <MemoryImportDialog spaceId={spaceId} onClose={() => setImporting(false)} /> : null}
      {exporting ? <MemoryExportDialog spaceId={spaceId} onClose={() => setExporting(false)} /> : null}
    </div>
  )
}
