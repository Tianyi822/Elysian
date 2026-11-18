import { TOOLTIP_BODY_CLASS } from './tooltipStyles'
import * as Popover from '@radix-ui/react-popover'
import * as Tooltip from '@radix-ui/react-tooltip'
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { PlatformMemorySample } from '@elysian/contracts'
import type { SystemLoad } from '../contracts/adapters'
import type { PlatformMemoryView } from '../stores/systemLoadStore'
import { formatFromMiB } from '../utils/formatBytes'
import { formatDateTime } from './format'
import { ChevronRight, CircleHelp, Gauge } from './icons'
import { Button } from './Button'
import { PeekCard } from './easyui/PeekCard'

function formatMiB(valueMb: number): string {
  return formatFromMiB(valueMb, { maxUnit: 'mega' })
}

function formatResident(sample: PlatformMemorySample): string {
  if (sample.rssMb === null) return '不可用'
  return `${sample.rssSource === 'statm' ? '≈ ' : ''}${formatMiB(sample.rssMb)}`
}

function formatTotalMemory(valueMb: number | null): string {
  if (valueMb === null) return '—'
  return formatFromMiB(valueMb, { digits: { giga: 2 } })
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
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-3">
      <p className="mb-1.5 flex items-center gap-1.5 font-medium text-fg-subtle">
        {title}
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
        <Button unstyled
          type="button"
          aria-label="内存口径说明"
          className="inline-flex size-4 items-center justify-center rounded text-fg-subtle outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-info"
        >
          <CircleHelp aria-hidden size={13} />
        </Button>
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
export function SystemLoadBadge({ memory: view, load, navigation = false, collapsed = false }: {
  memory: PlatformMemoryView
  load?: SystemLoad
  navigation?: boolean
  collapsed?: boolean
}) {
  const [open, setOpen] = useState(false)
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
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <Popover.Trigger asChild>
            <Button unstyled
              type="button"
              aria-label="系统负载"
              className={[
                'inline-flex items-center whitespace-nowrap rounded-lg text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus',
                navigation
                  ? `sidebar-row ${collapsed ? 'h-9 w-10 justify-center' : 'h-9 w-full px-2.5'} gap-3 hover:bg-sidebar-hover`
                  : 'gap-2 px-1.5 py-1 hover:bg-surface-raised',
                view.status === 'error'
                  ? 'text-danger'
                  : sample
                    ? navigation ? 'text-sidebar-muted hover:text-sidebar-fg' : 'text-fg-muted hover:text-fg'
                    : navigation ? 'text-sidebar-muted' : 'text-fg-subtle',
              ].join(' ')}
            >
              <span className={`inline-flex shrink-0 items-center justify-center ${navigation ? 'sidebar-row-icon size-5 [&>svg]:size-[18px]' : ''}`}>
                <Gauge aria-hidden size={16} />
              </span>
              <span className={collapsed ? 'sr-only' : 'tabular-nums'}>{loadText}</span>
              <span aria-hidden className={collapsed ? 'hidden' : undefined}>
                ·
              </span>
              <span className={collapsed ? 'sr-only' : 'tabular-nums'}>{memoryText}</span>
            </Button>
          </Popover.Trigger>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={6}
            className={`z-50 max-w-64 ${TOOLTIP_BODY_CLASS}`}
          >
            系统负载 · {hint}
            <Tooltip.Arrow className="fill-surface-raised" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>

      <PeekCard open={open} placement={navigation ? 'top' : 'bottom'} ariaLabel="系统负载明细"
        renderContent={() => <div className="text-xs">
          <p className="border-b border-line pb-2.5 text-sm font-semibold text-fg">系统负载</p>

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

              <RuntimeDetails sample={sample} />
            </>
          ) : (
            <Section title="面板内存">
              <p className="leading-relaxed text-fg-muted">
                {view.status === 'loading' ? '正在读取后端进程内存…' : '后端进程内存读取失败，稍后会再试。'}
              </p>
            </Section>
          )}

          {sample && (
            <p className="mt-3 border-t border-line pt-2 text-fg-subtle">
              采样于 {formatDateTime(sample.sampledAt)}
            </p>
          )}
        </div>}
      />
    </Popover.Root>
  )
}

function RuntimeDetails({ sample }: { sample: PlatformMemorySample }) {
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  return (
    <section className="mt-3">
      <div className="flex items-center gap-1.5">
        <Button unstyled type="button" aria-expanded={expanded} aria-controls={contentId}
          onClick={() => setExpanded(value => !value)}
          className="focus-ring flex items-center gap-1.5 rounded py-0.5 font-medium text-fg-subtle hover:text-fg">
          <ChevronRight aria-hidden size={14} className={expanded ? 'rotate-90' : undefined} />
          Go 运行时
        </Button>
        {expanded && <ScopeHelp />}
      </div>
      <div id={contentId} hidden={!expanded}>
        {expanded && <dl className="mt-1.5 grid grid-cols-2 gap-x-5 gap-y-1.5">
          <Row label="堆已用" value={formatMiB(sample.heapUsedMb)} />
          <Row label="存活堆" value={formatMiB(sample.heapLiveMb)} />
          <Row label="堆预留" value={formatMiB(sample.heapTotalMb)} />
          <Row label="堆内空位" value={formatMiB(sample.heapUnusedMb)} />
          <Row label="空闲未归还" value={formatMiB(sample.heapRetainedMb)} />
          <Row label="已归还系统" value={formatMiB(sample.heapReleasedMb)} />
          <Row label="栈与元数据" value={formatMiB(sample.runtimeOtherMb)} />
          <Row label="GC 次数" value={String(sample.gcCount)} />
        </dl>}
      </div>
    </section>
  )
}
