import * as Popover from '@radix-ui/react-popover'
import * as Tooltip from '@radix-ui/react-tooltip'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchPlatformMemory } from '../adapters/http/platformMemoryAdapter'
import type { PlatformMemorySample } from '../adapters/platformMemory/types'
import { formatDateTime } from './format'
import { CircleHelp, MemoryStick } from './icons'

/**
 * 内存自检：顶栏的自诊断图标，采集 Elysian 后端进程自身的常驻内存。
 *
 * 顶栏只显图标与绝对用量、不显百分比——百分比与仪表盘的「内存占用率」卡同屏会被读成
 * 同一口径的两个数；占系统总内存的比例连同它的分母一起收进点击浮层。
 * 数据由同源 GET /api/platform/memory 采集 Go 后端进程，不包含浏览器、开发启动器或其他容器。
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
  read: (signal?: AbortSignal) => Promise<PlatformMemorySample> = readPlatformMemory,
): MemoryView {
  const [view, setView] = useState<MemoryView>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    let pending = false
    const controller = new AbortController()
    const tick = async () => {
      if (pending) return
      pending = true
      try {
        const sample = await read(controller.signal)
        if (!cancelled) setView({ status: 'ready', sample })
      } catch {
        if (!cancelled) setView({ status: 'error' })
      } finally {
        pending = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), intervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
      controller.abort()
    }
  }, [intervalMs, read])

  return view
}

function readPlatformMemory(signal?: AbortSignal): Promise<PlatformMemorySample> {
  return fetchPlatformMemory('/api/platform/memory', signal)
}

function formatMiB(valueMb: number): string {
  return `${valueMb.toFixed(1)} MiB`
}

function formatResident(sample: PlatformMemorySample): string {
  if (sample.rssMb === null) return '不可用'
  return `${sample.rssSource === 'statm' ? '≈ ' : ''}${formatMiB(sample.rssMb)}`
}

function formatTotalMemory(valueMb: number | null): string {
  if (valueMb === null) return '—'
  return valueMb >= 1024 ? `${(valueMb / 1024).toFixed(2)} GiB` : formatMiB(valueMb)
}

function memoryPercent(value: number | null, total: number | null): number | null {
  if (value === null || total === null || total <= 0) return null
  return value / total * 100
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 whitespace-nowrap text-fg-muted">{label}</dt>
      <dd className="whitespace-nowrap tabular-nums text-fg">{value}</dd>
    </div>
  )
}

/** 浮层里的一组口径：标题说明这是哪一套算法，组内只放该算法下的量。 */
function Section({
  title,
  help,
  children,
}: {
  title: string
  help?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mt-3">
      <p className="mb-1.5 flex items-center gap-1.5 font-medium text-fg-subtle">
        {title}
        {help}
      </p>
      {children}
    </section>
  )
}

/** 两套口径的关系说明：常驻内存与 Go 运行时对不上是正常现象，点开才看得到解释。 */
function ScopeHelp() {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="内存口径说明"
          className="inline-flex size-4 items-center justify-center rounded text-fg-subtle outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-info"
        >
          <CircleHelp aria-hidden size={13} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          aria-label="内存口径说明"
          className="z-50 w-72 space-y-2 rounded-lg border border-line bg-surface-raised p-3 text-xs leading-relaxed text-fg-muted shadow-lg"
        >
          <p>常驻内存由操作系统记账：这个进程此刻实际占着多少物理内存。</p>
          <p>
            Go 运行时由 Go 自己记账：堆、栈与 GC 元数据各占多少。其中「堆预留」包含已经还给系统、
            只是地址空间还留着的部分，所以这一组的数会明显大于常驻内存。
          </p>
          <p>两套账本口径不同，数字对不上是正常现象，不能相加，也不能互相换算。</p>
          <Popover.Arrow className="fill-surface-raised" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/**
 * 顶栏内存自检：图标加常驻用量，悬停有说明，点击展开两套口径的明细。
 */
export function MemoryMonitorBadge() {
  const view = usePlatformMemory()
  const sample = view.status === 'ready' ? view.sample : null
  const residentPercent = sample ? memoryPercent(sample.rssMb, sample.systemTotalMb) : null
  const value = sample
    ? formatResident(sample)
    : view.status === 'loading'
      ? '采集中'
      : '采集失败'
  const ratio = residentPercent === null ? '—' : `${residentPercent.toFixed(1)}%`
  const hint = sample
    ? sample.rssMb === null
      ? '暂时无法读取后端内存'
      : '点击查看后端进程内存明细'
    : view.status === 'loading'
      ? '正在读取后端内存'
      : '后端内存读取失败，稍后会再试'

  return (
    <Popover.Root>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label="内存自检"
              className={[
                'inline-flex items-center gap-1.5 whitespace-nowrap rounded px-1.5 py-1 text-xs outline-none transition-colors',
                'hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                view.status === 'error'
                  ? 'text-danger'
                  : sample
                    ? 'text-fg-muted hover:text-fg'
                    : 'text-fg-subtle',
              ].join(' ')}
            >
              <MemoryStick aria-hidden size={16} className="shrink-0" />
              <span className="leading-none tabular-nums">{value}</span>
            </button>
          </Popover.Trigger>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={6}
            className="z-50 max-w-64 rounded border border-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg"
          >
            内存自检 · {hint}
            <Tooltip.Arrow className="fill-surface-raised" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label="内存自检详情"
          className="z-50 w-80 rounded-lg border border-line bg-surface-raised p-3 text-xs shadow-lg"
        >
          <p className="border-b border-line pb-2 text-sm font-medium text-fg">内存自检</p>
          <p className="pt-2 leading-relaxed text-fg-subtle">
            只统计 Elysian 后端进程自身占用的内存。
          </p>

          {sample ? (
            <>
              <Section title="进程常驻（RSS）">
                <dl className="space-y-1.5">
                  <Row label="常驻内存" value={formatResident(sample)} />
                  <Row label="系统总内存" value={formatTotalMemory(sample.systemTotalMb)} />
                  <Row label="占系统总内存" value={ratio} />
                </dl>
                {residentPercent !== null && (
                  <div
                    role="meter"
                    aria-label="后端常驻内存占系统总内存"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.min(100, residentPercent)}
                    aria-valuetext={`${formatResident(sample)}，占系统总内存的 ${ratio}`}
                    className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line"
                  >
                    <span
                      className="block h-full bg-info/40"
                      style={{ width: `${Math.min(100, Math.max(1.5, residentPercent))}%` }}
                    />
                  </div>
                )}
              </Section>

              <Section title="Go 运行时" help={<ScopeHelp />}>
                <dl className="grid grid-cols-2 gap-x-5 gap-y-1.5">
                  <Row label="堆已用" value={formatMiB(sample.heapUsedMb)} />
                  <Row label="存活堆" value={formatMiB(sample.heapLiveMb)} />
                  <Row label="堆预留" value={formatMiB(sample.heapTotalMb)} />
                  <Row label="堆内空位" value={formatMiB(sample.heapUnusedMb)} />
                  <Row label="空闲未归还" value={formatMiB(sample.heapRetainedMb)} />
                  <Row label="已归还系统" value={formatMiB(sample.heapReleasedMb)} />
                  <Row label="栈与元数据" value={formatMiB(sample.runtimeOtherMb)} />
                  <Row label="GC 次数" value={String(sample.gcCount)} />
                </dl>
              </Section>
            </>
          ) : (
            <p className="mt-3 leading-relaxed text-fg-muted">
              {view.status === 'loading' ? '正在读取后端进程内存…' : '后端进程内存读取失败，稍后会再试。'}
            </p>
          )}

          <p className="mt-3 border-t border-line pt-2 text-fg-subtle">
            每 {SAMPLE_INTERVAL_MS / 1000} 秒采样一次
            {sample ? ` · 采样于 ${formatDateTime(sample.sampledAt)}` : ''}
          </p>
          <Popover.Arrow className="fill-surface-raised" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
