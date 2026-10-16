import { useEffect, useRef, useState, type CSSProperties } from 'react'
import * as Popover from '@radix-ui/react-popover'
import type { AgentChatTimelineSnapshot } from '@elysian/contracts'
import './chatUsageIndicator.css'

const tokenNumber = new Intl.NumberFormat('en-US')
const contextPercent = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const categoryLabels = [
  ['messages', '消息'], ['systemTools', '系统工具'], ['other', '其他'],
  ['skills', '技能'], ['systemPrompt', '系统提示词'], ['mcpTools', 'MCP 工具'],
] as const

export function ChatUsageIndicator({ timeline }: { timeline?: AgentChatTimelineSnapshot }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const hovered = useRef(false)
  const touch = useRef(false)
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const context = timeline?.contextUsage
  const total = context?.totalTokens
  const capacity = context?.contextTokens
  const ratio = total !== undefined && capacity !== undefined && capacity > 0 ? total / capacity : undefined
  const progress = ratio === undefined ? undefined : Math.min(100, Math.round(ratio * 1000) / 10)
  const actual = timeline?.usage?.actualTokens
  const cached = timeline?.usage?.cachedTokens
  const cacheHit = timeline?.cacheHitUsage
  const cachedRatio = cacheHit && cacheHit.inputTokens > 0 && cacheHit.cachedTokens <= cacheHit.inputTokens ? cacheHit.cachedTokens / cacheHit.inputTokens : undefined
  const hasRunUsage = actual !== undefined || cached !== undefined || cacheHit !== undefined
  const breakdown = context?.estimatedBreakdown
  const estimatedTotal = breakdown ? categoryLabels.reduce((sum, [key]) => sum + breakdown[key], 0) : 0
  const contextValue = context
    ? `${total === undefined ? '未报告' : tokenNumber.format(total)} / ${tokenNumber.format(context.contextTokens)}${ratio === undefined ? '' : `（${contextPercent.format(ratio * 100)}%）`}`
    : '暂无推理用量'
  const style = { '--chat-usage-progress': `${progress ?? 0}%` } as CSSProperties

  const cancelClose = () => {
    clearTimeout(closing.current)
    closing.current = undefined
  }
  const reveal = () => { cancelClose(); setOpen(true) }
  const closeSoon = () => {
    cancelClose()
    // 留出跨越触发器与浮层间距的时间；焦点或指针仍在任一处时保持展开。
    closing.current = setTimeout(() => {
      const focused = document.activeElement
      if (!hovered.current && !trigger.current?.contains(focused) && !panel.current?.contains(focused)) setOpen(false)
    }, 140)
  }
  const pointerEnter = () => { hovered.current = true; reveal() }
  const pointerLeave = () => { hovered.current = false; closeSoon() }
  useEffect(() => () => clearTimeout(closing.current), [])

  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button ref={trigger} type="button" aria-label="上下文用量" className="chat-usage-trigger"
        onPointerEnter={event => { if (event.pointerType !== 'touch') pointerEnter() }}
        onPointerLeave={event => { if (event.pointerType !== 'touch') pointerLeave() }}
        onPointerDown={event => { touch.current = event.pointerType === 'touch' }}
        onFocus={() => { if (!touch.current) reveal() }} onBlur={closeSoon}
        onClick={event => { event.preventDefault(); cancelClose(); setOpen(value => !value); touch.current = false }}>
        <span aria-hidden className="chat-usage-ring" data-known={ratio !== undefined || undefined} style={style} />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content ref={panel} aria-label="上下文用量明细" side="top" align="end" sideOffset={8} collisionPadding={12}
        className="chat-usage-panel panel-surface" onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
        onPointerEnter={pointerEnter} onPointerLeave={pointerLeave} onFocus={reveal} onBlur={closeSoon}
        onEscapeKeyDown={() => { cancelClose(); setOpen(false) }}>
        <div className="chat-usage-heading"><span>上下文用量</span><span className="chat-usage-value">{contextValue}</span></div>
        {ratio !== undefined && <div className="chat-usage-bar" style={style} role="meter" aria-label="最近一次推理上下文用量"
          aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={Math.min(total!, capacity!)} aria-valuetext={contextValue}>
          <span />
        </div>}
        {context && <div className="chat-usage-source"><span>最近一次推理</span><span>{context.model}</span></div>}
        {breakdown ? <div className="chat-usage-breakdown">
          <p>分类占用<span>本地估算</span></p>
          <dl>{categoryLabels.map(([key, label]) => <div key={key}>
            <dt>{label}</dt><dd><span>≈ {tokenNumber.format(breakdown[key])}</span>
              {estimatedTotal > 0 && <span>{contextPercent.format(breakdown[key] / estimatedTotal * 100)}%</span>}
            </dd>
          </div>)}</dl>
        </div> : context && <p className="chat-usage-unreported">分类占用未采集</p>}
        {hasRunUsage && <div className="chat-usage-run">
          <p>本轮累计</p>
          <dl>
            {actual !== undefined && <div><dt>tokens</dt><dd>{tokenNumber.format(actual)}</dd></div>}
            {cached !== undefined && <div><dt>缓存 tokens</dt><dd>{tokenNumber.format(cached)}</dd></div>}
            <div><dt>平均缓存命中率</dt><dd>{cachedRatio === undefined ? '未报告' : `${contextPercent.format(cachedRatio * 100)}%`}</dd></div>
          </dl>
          {cachedRatio !== undefined && <p className="chat-usage-footnote">已完成请求 · 按输入 token 加权</p>}
        </div>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}
