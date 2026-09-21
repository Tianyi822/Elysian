import * as Tooltip from '@radix-ui/react-tooltip'
import * as Popover from '@radix-ui/react-popover'
import { MemoryStick } from './icons'
import { useEffect, useState } from 'react'
import { fetchPlatformMemory } from '../adapters/http/platformMemoryAdapter'
import type { PlatformMemorySample } from '../adapters/platformMemory/types'

/**
 * 平台内存占用：监控 Elysian 进程自身的常驻内存，用于诊断与优化。
 *
 * 数据由本机 GET /api/platform/memory 采集 process.memoryUsage，不是浏览器 JS 堆。
 * 采不到时如实显示失败，不伪造数字。
 */

export const SAMPLE_INTERVAL_MS = 5_000

type MemoryView =
  | { status: 'loading' }
  | { status: 'ready'; sample: PlatformMemorySample }
  | { status: 'error' }

/** 周期读取服务端进程内存；失败时保持 error，不把旧值伪装成当前事实。 */
export function usePlatformMemory(
  intervalMs = SAMPLE_INTERVAL_MS,
  read: () => Promise<PlatformMemorySample> = fetchPlatformMemory,
): MemoryView {
  const [view, setView] = useState<MemoryView>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const sample = await read()
        if (!cancelled) setView({ status: 'ready', sample })
      } catch {
        if (!cancelled) setView({ status: 'error' })
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), intervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [intervalMs, read])

  return view
}

function formatMb(valueMb: number): string {
  return `${valueMb.toFixed(1)} MB`
}

/**
 * 顶栏内存自检：图标与常驻占用常驻，悬停有说明，点击展开 RSS 与堆详情。
 */
export function MemoryMonitorBadge() {
  const view = usePlatformMemory()
  const ready = view.status === 'ready'

  return (
    <Popover.Root>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label="平台内存占用"
              className={[
                'inline-flex items-center gap-1.5 whitespace-nowrap rounded border px-2 py-0.5 text-xs transition-colors',
                ready
                  ? 'border-line bg-surface text-fg-muted hover:text-fg'
                  : 'border-line bg-surface text-fg-subtle opacity-60',
              ].join(' ')}
            >
              <MemoryStick aria-hidden size={13} />
              {view.status === 'ready' ? (
                <>
                  <span className="hidden sm:inline">平台内存占用 </span>
                  <span className="tabular-nums">{formatMb(view.sample.rssMb)}</span>
                </>
              ) : view.status === 'loading' ? (
                <span>采集中</span>
              ) : (
                <span>采集失败</span>
              )}
            </button>
          </Popover.Trigger>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={6}
            className="z-50 rounded border border-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg"
          >
            {view.status === 'ready'
              ? 'Elysian 进程常驻内存，由服务端采集，点击查看详情'
              : view.status === 'loading'
                ? '正在从本机端点读取进程内存'
                : '本机端点读取失败，稍后会再试'}
            <Tooltip.Arrow className="fill-surface-raised" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-64 rounded-lg border border-line bg-surface-raised p-3 text-xs shadow-lg"
        >
          <p className="mb-2 border-b border-line pb-1.5 text-sm font-medium">平台内存占用</p>
          {view.status === 'ready' ? (
            <dl className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-fg-muted">常驻内存</dt>
                <dd className="tabular-nums text-fg">{formatMb(view.sample.rssMb)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-fg-muted">堆已用</dt>
                <dd className="tabular-nums text-fg">{formatMb(view.sample.heapUsedMb)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-fg-muted">堆已分配</dt>
                <dd className="tabular-nums text-fg">{formatMb(view.sample.heapTotalMb)}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-fg-muted">
              {view.status === 'loading' ? '正在采集进程内存…' : '无法读取本机进程内存，请确认开发服务器仍在运行。'}
            </p>
          )}
          <p className="mt-2 border-t border-line pt-1.5 text-fg-subtle">
            每 5 秒向本机端点采样一次，数字来自 Elysian 进程自身，不是浏览器页面堆。
          </p>
          <Popover.Arrow className="fill-surface-raised" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
