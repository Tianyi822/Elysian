import { useEffect } from 'react'
import type { AgentMemoryChecks } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'

/*
 * 「检查」页签：orphanPages/brokenLinks/expiredPages/invalidSources 四组一致性
 * 报告（GET …/checks，服务端现场计算）。
 */
const GROUPS: readonly { key: keyof AgentMemoryChecks; title: string; hint: string }[] = [
  { key: 'orphanPages', title: '孤立页面', hint: '没有任何入链且自身无出链的页面' },
  { key: 'brokenLinks', title: '失效链接', hint: '指向不存在或已撤回页面的 [[链接]]' },
  { key: 'expiredPages', title: '过期页面', hint: '有效期已过但仍未撤回的页面' },
  { key: 'invalidSources', title: '失效来源', hint: '来源修订缺失或摘要不一致' },
]

export function MemoryChecksTab({ spaceId }: { spaceId?: string }) {
  const gateway = useGateway()
  const status = useAgentMemoryStore((state) => state.checksStatus)
  const reloading = useAgentMemoryStore((state) => state.checksReloading)
  const report = useAgentMemoryStore((state) => state.checks)
  const errorMessage = useAgentMemoryStore((state) => state.checksErrorMessage)
  const load = useAgentMemoryStore((state) => state.loadChecks)

  useEffect(() => {
    if (spaceId !== undefined) void load(gateway, spaceId)
  }, [gateway, spaceId, load])

  return (
    <div className="busy-host relative flex flex-col gap-3">
      <BusyVeil busy={reloading} />
      <div className="flex items-center gap-2">
        <p className="text-xs leading-5 text-fg-muted">
          检查在读取时由服务端现场计算，覆盖当前空间全部页面（含已撤回）；只报告事实，不自动修复。
        </p>
        <span className="ml-auto">
          <RefreshButton
            label="重新检查"
            onPress={() => spaceId !== undefined && void load(gateway, spaceId)}
            busy={reloading}
          />
        </span>
      </div>
      {spaceId === undefined ? <EmptyState title="先在左侧选择空间" /> : null}
      {spaceId !== undefined && (status === 'loading' || status === 'idle') ? <LoadingState label="正在执行一致性检查…" /> : null}
      {spaceId !== undefined && status === 'error' ? (
        <ErrorState description={errorMessage} onRetry={() => void load(gateway, spaceId)} />
      ) : null}
      {spaceId !== undefined && status === 'ready' && report !== undefined ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {GROUPS.map((group) => {
            const items = report[group.key]
            return (
              <section key={group.key} aria-label={group.title} className="panel-surface p-4">
                <header className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{group.title}</h3>
                  <span className="text-xs tabular-nums text-fg-subtle">{items.length} 项</span>
                </header>
                <p className="mt-1 text-xs text-fg-subtle">{group.hint}</p>
                {items.length === 0 ? (
                  <p className="mt-2 text-xs text-fg-muted">无异常。</p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-1">
                    {items.map((item) => (
                      <li key={item} className="rounded border border-line px-2 py-1 font-mono text-xs break-all text-fg-muted">
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
