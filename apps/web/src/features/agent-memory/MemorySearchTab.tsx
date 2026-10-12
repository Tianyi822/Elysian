import { useEffect, useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { LoadingState, ErrorState, EmptyState } from '../../components/states/StateViews'
import { CTL_FIELD, CTL_PRIMARY } from '../../components/formControl'
import { Search as SearchIcon } from '../../components/icons'
import { StatusTag } from '../../components/StatusTag'
import { SelectDropdown } from '../../components/SelectDropdown'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { MEMORY_SEARCH_METHOD_LABELS } from './memoryLabels'

/*
 * 「搜索」页签：q + limit（默认 8）直连 GET …/search。命中展示 page/score/method；
 * degraded 时给出服务端 reason（向量不可用即 SQLite 文本回落，不是错误态）。
 */
const LIMIT_OPTIONS = [4, 8, 16, 32] as const

export function MemorySearchTab({ spaceId, onOpenPage }: { spaceId: string; onOpenPage(pageId: string): void }) {
  const gateway = useGateway()
  const status = useAgentMemoryStore((state) => state.searchStatus)
  const result = useAgentMemoryStore((state) => state.searchResult)
  const errorMessage = useAgentMemoryStore((state) => state.searchErrorMessage)
  const lastQuery = useAgentMemoryStore((state) => state.searchQuery)
  const runSearch = useAgentMemoryStore((state) => state.runSearch)
  const clearSearch = useAgentMemoryStore((state) => state.clearSearch)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState<number>(8)

  useEffect(() => {
    setQuery('')
    clearSearch()
  }, [spaceId, clearSearch])

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const trimmed = query.trim()
          if (trimmed === '') {
            clearSearch()
            return
          }
          void runSearch(gateway, spaceId, trimmed, limit)
        }}
      >
        <div className="min-w-56 flex-1">
          <label htmlFor="memory-search-query" className="block text-xs text-fg-muted">检索内容</label>
          <div className="relative mt-1">
            <SearchIcon aria-hidden size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-subtle" />
            <input
              id="memory-search-query"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="按标题、slug、标签与正文检索本空间"
              className={`${CTL_FIELD} pl-8`}
            />
          </div>
        </div>
        <div>
          <label htmlFor="memory-search-limit" className="block text-xs text-fg-muted">条数上限</label>
          <SelectDropdown
            id="memory-search-limit"
            ariaLabel="条数上限"
            value={String(limit)}
            onSelect={(value) => setLimit(Number(value))}
            items={LIMIT_OPTIONS.map((value) => ({ value: String(value), label: String(value) }))}
            className="mt-1 w-24"
          />
        </div>
        <button type="submit" className={CTL_PRIMARY}>检索页面</button>
      </form>

      {status === 'loading' ? <LoadingState label="正在检索…" /> : null}
      {status === 'error' ? <ErrorState description={errorMessage} onRetry={() => lastQuery !== undefined ? void runSearch(gateway, spaceId, lastQuery, limit) : undefined} /> : null}
      {status === 'ready' && result !== undefined ? (
        result.items.length === 0 ? (
          <>
            {result.degraded ? <p role="status" className="text-xs text-fg-muted">当前为降级检索：{result.reason ?? '向量索引不可用，已回落文本检索'}</p> : null}
            <EmptyState title="没有命中页面" description="换个关键词，或确认页面没有被撤回、过期或因来源失效被过滤。" />
          </>
        ) : (
          <div className="flex flex-col gap-2">
            {result.degraded ? (
              <p role="status" className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-fg-muted">
                当前为降级检索：{result.reason ?? '向量索引不可用，已回落文本检索'}。命中仍由 SQLite 全文给出，不会丢页面。
              </p>
            ) : (
              <p role="status" className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-fg-muted">
                混合检索生效：文本与向量结果按 RRF 融合。
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {result.items.map((hit) => (
                <li key={hit.page.id} className="panel-surface p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="text-left text-sm font-medium text-fg underline-offset-2 hover:underline" onClick={() => onOpenPage(hit.page.id)}>{hit.page.title}</button>
                    <StatusTag label={MEMORY_SEARCH_METHOD_LABELS[hit.method]} tone={hit.method === 'hybrid-rrf' ? 'success' : 'neutral'} />
                    <span className="text-xs tabular-nums text-fg-subtle">score {hit.score.toFixed(3)}</span>
                    <span className="font-mono text-xs text-fg-muted">{hit.page.slug}</span>
                  </div>
                  <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-fg-muted">{hit.page.markdown}</p>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}
    </div>
  )
}
