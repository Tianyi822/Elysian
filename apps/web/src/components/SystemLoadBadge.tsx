import * as Popover from '@radix-ui/react-popover'
import * as Tooltip from '@radix-ui/react-tooltip'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchPlatformMemory } from '../adapters/http/platformMemoryAdapter'
import type { PlatformMemorySample } from '../adapters/platformMemory/types'
import type { SystemLoad } from '../adapters/mock/resourceMetrics'
import { formatDateTime } from './format'
import { CircleHelp, Gauge } from './icons'
import { getLastResourceSample, onStreamEvent } from '../stores/eventStreamStore'

/**
 * 系统负载指示器：合并这台机器的忙闲（load average）与面板自身内存。
 *
 * 负载随事件流每拍到达，内存每 5 秒采一次后端进程；两个口径不同，常驻读数只给
 * 1 分钟负载与内存用量，三档负载与内存明细收在点击浮层里分节列出。
 * 采不到时如实显示失败或占位，不伪造数字。
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

/**
 * 最新一拍的 load average：事件流每拍带过来，挂载晚于首拍时从缓存回放。
 * 事件流没接通时保持 undefined，界面显示占位而不是 0（0 会被读成机器空闲）。
 */
export function useSystemLoad(): SystemLoad | undefined {
  const [load, setLoad] = useState<SystemLoad | undefined>(() => readLoad(getLastResourceSample()))
  useEffect(
    () =>
      onStreamEvent((event) => {
        const next = readLoad(event)
        if (next) setLoad(next)
      }),
    [],
  )
  return load
}

function readLoad(event: ReturnType<typeof getLastResourceSample>): SystemLoad | undefined {
  return event?.name === 'resource/sample' ? event.payload.load : undefined
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

/** 浮层里的一组：标题说明这是哪个口径，组内只放该口径下的读数。 */
function Section({ title, help, children }: { title: string; help?: ReactNode; children: ReactNode }) {
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

/** 两套内存口径的关系说明：常驻内存与 Go 运行时对不上是正常现象，点开才看得到解释。 */
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
          className="z-50 w-72 space-y-2 rounded-lg border border-control-line bg-surface-raised p-3 text-xs leading-relaxed text-fg-muted shadow-lg"
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
 * 导航底部常驻 1 分钟负载与面板内存，收起时通过图标进入明细。
 */
export function SystemLoadBadge({ navigation = false, collapsed = false }: { navigation?: boolean; collapsed?: boolean }) {
  const view = usePlatformMemory()
  const load = useSystemLoad()
  const sample = view.status === 'ready' ? view.sample : null
  const residentPercent = sample ? memoryPercent(sample.rssMb, sample.systemTotalMb) : null
  const memoryText = sample
    ? formatResident(sample)
    : view.status === 'loading'
      ? '采集中'
      : '采集失败'
  const loadText = load ? load.m1.toFixed(2) : '—'
  const ratio = residentPercent === null ? '—' : `${residentPercent.toFixed(1)}%`
  const hint = sample
    ? sample.rssMb === null
      ? '暂时无法读取后端内存，点击查看负载明细'
      : '点击查看 1/5/15 分钟负载与内存明细'
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
              aria-label="系统负载"
              className={[
                'inline-flex items-center whitespace-nowrap rounded-lg text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus',
                navigation
                  ? `${collapsed ? 'size-10 justify-center' : 'min-h-9 w-full px-3'} gap-3 hover:bg-nav-hover`
                  : 'gap-2 px-1.5 py-1 hover:bg-surface-raised',
                view.status === 'error'
                  ? 'text-danger'
                  : sample
                    ? navigation ? 'text-nav-muted hover:text-nav-fg' : 'text-fg-muted hover:text-fg'
                    : navigation ? 'text-nav-muted' : 'text-fg-subtle',
              ].join(' ')}
            >
              <span className={`inline-flex shrink-0 items-center justify-center ${navigation ? 'size-6' : ''}`}>
                <Gauge aria-hidden size={16} />
              </span>
              <span className={collapsed ? 'sr-only' : 'tabular-nums'}>{loadText}</span>
              <span aria-hidden className={collapsed ? 'hidden' : undefined}>
                ·
              </span>
              <span className={collapsed ? 'sr-only' : 'tabular-nums'}>{memoryText}</span>
            </button>
          </Popover.Trigger>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={6}
            className="z-50 max-w-64 rounded border border-control-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg"
          >
            系统负载 · {hint}
            <Tooltip.Arrow className="fill-surface-raised" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>

      <Popover.Portal>
        <Popover.Content
          side={navigation ? collapsed ? 'right' : 'top' : 'bottom'}
          align={navigation ? 'start' : 'end'}
          sideOffset={6}
          collisionPadding={8}
          aria-label="系统负载明细"
          className="panel-surface z-50 w-80 max-w-[calc(100vw-2rem)] p-3 text-xs shadow-lg"
        >
          <p className="border-b border-line pb-2 text-sm font-medium text-fg">系统负载</p>
          <p className="pt-2 leading-relaxed text-fg-subtle">
            负载是这台机器的忙闲读数，面板内存只统计 Elysian 后端进程自身占用的内存。
          </p>

          <Section title="机器负载（load average）">
            {load ? (
              <dl className="space-y-1.5">
                <Row label="1 分钟" value={load.m1.toFixed(2)} />
                <Row label="5 分钟" value={load.m5.toFixed(2)} />
                <Row label="15 分钟" value={load.m15.toFixed(2)} />
              </dl>
            ) : (
              <p className="leading-relaxed text-fg-muted">
                还没收到事件流的资源采样，负载读数暂不可用。
              </p>
            )}
          </Section>

          {sample ? (
            <>
              <Section title="面板常驻内存（RSS）">
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
            <Section title="面板内存">
              <p className="leading-relaxed text-fg-muted">
                {view.status === 'loading' ? '正在读取后端进程内存…' : '后端进程内存读取失败，稍后会再试。'}
              </p>
            </Section>
          )}

          <p className="mt-3 border-t border-line pt-2 text-fg-subtle">
            负载每拍随事件流更新 · 内存每 {SAMPLE_INTERVAL_MS / 1000} 秒采样一次
            {sample ? ` · 采样于 ${formatDateTime(sample.sampledAt)}` : ''}
          </p>
          <Popover.Arrow className="fill-surface-raised" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
