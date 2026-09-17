import { useEffect, useMemo, useRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { formatByteSize } from '../../components/format'
import { Search } from '../../components/icons'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { useRuntimeLogStore } from '../../stores/runtimeLogStore'

/**
 * 平台运行日志面板：等宽字体的只读日志视图，底色与文字走语义令牌、随主题切换，
 * 对比度由令牌层保证（浅色主题浅底深字、深色主题深底浅字）。
 * 工具栏提供刷新日志、滑动日志（自动滚底）开关、日志大小与按行过滤的搜索；
 * 全屏展示用 Radix Dialog 铺满视口，与内嵌视图共用同一个 LogView。
 * 参照产品里的「请求反馈」入口不保留（营销客服元素）。
 */

/** 工具按钮：与防火墙面板同款的中性描边小按钮；给 pressed 时按开关形态高亮。 */
function ToolButton({
  label,
  onClick,
  disabled = false,
  pressed,
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
  pressed?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className={`inline-flex items-center rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
        pressed
          ? 'border-accent/50 bg-accent/10 text-accent'
          : 'border-line bg-surface-raised text-fg hover:border-fg-subtle'
      }`}
    >
      {label}
    </button>
  )
}

/** 按行内级别标记着色（语义令牌，两主题下均满足对比度红线）：ERROR 危险色、WARNING 警告色、DEBUG 次要文字，其余正文色。 */
export function logLineToneClass(line: string): string {
  if (line.includes('[ERROR]')) return 'text-danger'
  if (line.includes('[WARNING]')) return 'text-warning'
  if (line.includes('[DEBUG]')) return 'text-fg-muted'
  return 'text-fg'
}

/** 日志行视图：内嵌与全屏共用；follow 为真时内容变化后滚到底部。 */
function LogView({
  lines,
  follow,
  className,
}: {
  lines: readonly string[]
  follow: boolean
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // jsdom 未实现 Element.scrollTo，可选调用让测试环境降级为 no-op，浏览器行为不变。
    if (follow) ref.current?.scrollTo?.({ top: ref.current.scrollHeight })
  }, [follow, lines])

  return (
    <div
      ref={ref}
      role="log"
      aria-label="平台运行日志"
      className={`overflow-y-auto rounded-xl border border-line bg-surface px-4 py-3 font-mono text-sm leading-relaxed ${className ?? ''}`}
    >
      {lines.length === 0 ? (
        <p className="text-fg-muted">没有匹配的日志行</p>
      ) : (
        lines.map((line, index) => (
          <p key={index} className={`whitespace-pre-wrap break-all ${logLineToneClass(line)}`}>
            {line}
          </p>
        ))
      )}
    </div>
  )
}

export function RuntimeLogPanel() {
  const gateway = useGateway()
  const status = useRuntimeLogStore((s) => s.status)
  const errorMessage = useRuntimeLogStore((s) => s.errorMessage)
  const snapshot = useRuntimeLogStore((s) => s.snapshot)
  const search = useRuntimeLogStore((s) => s.search)
  const follow = useRuntimeLogStore((s) => s.follow)
  const fullscreen = useRuntimeLogStore((s) => s.fullscreen)
  const refreshing = useRuntimeLogStore((s) => s.refreshing)
  const load = useRuntimeLogStore((s) => s.load)
  const setSearch = useRuntimeLogStore((s) => s.setSearch)
  const setFollow = useRuntimeLogStore((s) => s.setFollow)
  const setFullscreen = useRuntimeLogStore((s) => s.setFullscreen)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  const lines = useMemo(
    () => (snapshot ? snapshot.content.split('\n').filter((line) => line.length > 0) : []),
    [snapshot],
  )
  const keyword = search.trim()
  const visibleLines = useMemo(
    () => (keyword ? lines.filter((line) => line.includes(keyword)) : lines),
    [lines, keyword],
  )

  if (status === 'loading' || status === 'idle') {
    return <LoadingState label="正在加载运行日志…" />
  }

  if (status === 'error' || !snapshot) {
    return <ErrorState title="运行日志加载失败" description={errorMessage} onRetry={() => void load(gateway)} />
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3">
        <div className="relative w-64 max-w-full">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
          />
          <label htmlFor="runtime-log-search" className="sr-only">
            搜索日志关键字
          </label>
          <input
            id="runtime-log-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="请输入搜索关键字"
            className="w-full rounded-lg border border-line bg-surface-raised py-1.5 pl-8 pr-3 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle"
          />
        </div>
        <ToolButton label={refreshing ? '刷新中…' : '刷新日志'} disabled={refreshing} onClick={() => void load(gateway)} />
        <ToolButton label="滑动日志" pressed={follow} onClick={() => setFollow(!follow)} />
        <span className="text-xs text-fg-muted">
          日志大小：<span className="tabular-nums text-fg">{formatByteSize(snapshot.sizeBytes)}</span>
        </span>
      </div>

      <LogView lines={visibleLines} follow={follow} className="h-[calc(100dvh-16rem)] min-h-72" />

      <div className="mt-3 flex justify-end">
        {/* 文案固定「全屏展示」，避免与弹窗内的「退出全屏」按钮重名；开合靠 pressed 高亮表达。 */}
        <ToolButton label="全屏展示" pressed={fullscreen} onClick={() => setFullscreen(!fullscreen)} />
      </div>

      <Dialog.Root open={fullscreen} onOpenChange={setFullscreen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-0 z-[55] flex flex-col gap-3 bg-bg p-4"
          >
            <div className="flex items-center justify-between">
              <Dialog.Title className="text-sm font-medium text-fg">平台运行日志（全屏）</Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-lg border border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg"
                >
                  退出全屏
                </button>
              </Dialog.Close>
            </div>
            <LogView lines={visibleLines} follow={follow} className="min-h-0 flex-1" />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
