import * as Tooltip from '@radix-ui/react-tooltip'
import * as Popover from '@radix-ui/react-popover'
import { MemoryStick } from './icons'
import { useEffect, useState } from 'react'

/**
 * 平台内存占用：监控本页面（Elysian 自己）的 JS 堆占用，用于诊断与优化。
 *
 * 数据来自 performance.memory，只有 Chromium 内核提供；其他浏览器如实显示
 * 「当前浏览器不支持」，不伪造数据。纯本地 API，不产生网络请求。
 */

export type HeapSample = {
  /** 已用堆（MB）。 */
  usedMb: number
  /** 已为页面分配的堆（MB）。 */
  totalMb: number
  /** 堆上限（MB）。 */
  limitMb: number
}

type PerformanceMemory = {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

const BYTES_PER_MB = 1024 * 1024
export const SAMPLE_INTERVAL_MS = 5_000

/** 读取本页 JS 堆占用；API 不存在（非 Chromium）时返回 undefined。 */
export function readHeapSample(): HeapSample | undefined {
  const memory = (performance as { memory?: PerformanceMemory }).memory
  if (
    !memory ||
    typeof memory.usedJSHeapSize !== 'number' ||
    typeof memory.totalJSHeapSize !== 'number' ||
    typeof memory.jsHeapSizeLimit !== 'number'
  ) {
    return undefined
  }
  return {
    usedMb: memory.usedJSHeapSize / BYTES_PER_MB,
    totalMb: memory.totalJSHeapSize / BYTES_PER_MB,
    limitMb: memory.jsHeapSizeLimit / BYTES_PER_MB,
  }
}

/** 周期采样本页堆占用；不支持的环境里 sample 恒为 undefined。 */
export function useHeapSample(intervalMs = SAMPLE_INTERVAL_MS): HeapSample | undefined {
  const [sample, setSample] = useState<HeapSample | undefined>(() => readHeapSample())

  useEffect(() => {
    const tick = () => setSample(readHeapSample())
    const timer = setInterval(tick, intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return sample
}

function formatMb(valueMb: number): string {
  return `${valueMb.toFixed(1)} MB`
}

/**
 * 顶栏内存自检图标：图标与当前占用值常驻，悬停有说明，点击展开三项堆详情。
 * 不支持的环境里图标置灰并说明原因。
 */
export function MemoryMonitorBadge() {
  const sample = useHeapSample()
  const supported = sample !== undefined

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
                supported
                  ? 'border-line bg-surface text-fg-muted hover:text-fg'
                  : 'border-line bg-surface text-fg-subtle opacity-60',
              ].join(' ')}
            >
              <MemoryStick aria-hidden size={13} />
              {sample ? (
                <>
                  {/* 窄屏只留数值；名称由按钮的 aria-label 承载，读屏与用例查询都不受影响。 */}
                  <span className="hidden sm:inline">平台内存占用 </span>
                  <span className="tabular-nums">{formatMb(sample.usedMb)}</span>
                </>
              ) : (
                <span>内存自检不可用</span>
              )}
            </button>
          </Popover.Trigger>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={6}
            className="z-50 rounded border border-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg"
          >
            {supported
              ? 'Elysian 页面自身的 JS 堆占用，用于平台自诊断，点击查看详情'
              : '当前浏览器不提供内存自检 API（仅 Chromium 内核支持）'}
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
          {sample ? (
            <dl className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-fg-muted">已用堆</dt>
                <dd className="tabular-nums text-fg">{formatMb(sample.usedMb)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-fg-muted">已分配堆</dt>
                <dd className="tabular-nums text-fg">{formatMb(sample.totalMb)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-fg-muted">堆上限</dt>
                <dd className="tabular-nums text-fg">{formatMb(sample.limitMb)}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-fg-muted">
              当前浏览器不提供 performance.memory，无法自检内存。改用 Chromium 内核浏览器可查看。
            </p>
          )}
          <p className="mt-2 border-t border-line pt-1.5 text-fg-subtle">
            每 5 秒采样一次，数据只来自本页面，用于平台自身的诊断与优化。
          </p>
          <Popover.Arrow className="fill-surface-raised" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
