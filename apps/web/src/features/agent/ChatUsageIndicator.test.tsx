import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatCacheHitUsage, AgentChatTimelineSnapshot, RuntimeUsage } from '@elysian/contracts'
import { chatTestCacheHitUsage, chatTestContextUsage } from '../../test/agentChatFixtures'
import { ChatUsageIndicator } from './ChatUsageIndicator'

const snapshot = (overrides: Partial<AgentChatTimelineSnapshot> = {}): AgentChatTimelineSnapshot => ({
  runId: 'run-1', status: 'succeeded', done: true, entries: [],
  contextUsage: { ...chatTestContextUsage, modelRequestId: 'request-2', model: 'glm-5.3' },
  usage: { calls: 3, resultBytes: 4096, actualTokens: 13364, cachedTokens: 8210 }, cacheHitUsage: chatTestCacheHitUsage, ...overrides,
})
const show = () => {
  fireEvent.pointerEnter(screen.getByRole('button', { name: '上下文用量' }), { pointerType: 'mouse' })
  return screen.getByRole('dialog', { name: '上下文用量明细' })
}
afterEach(() => vi.useRealTimers())

describe('输入区上下文与缓存用量', () => {
  it('最近推理填充圆环，按输入加权计算本轮平均缓存命中率并展示六类本地估算', () => {
    render(<ChatUsageIndicator timeline={snapshot()} />)
    const trigger = screen.getByRole('button', { name: '上下文用量' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger.querySelector('.chat-usage-ring')).toHaveStyle('--chat-usage-progress: 36.2%')
    const details = show()
    expect(details).not.toHaveAttribute('aria-live')
    expect(within(details).getByText('36,200 / 100,000（36.2%）')).toBeInTheDocument()
    expect(within(details).getByRole('meter')).toHaveAttribute('aria-valuenow', '36200')
    expect(within(details).getByText('最近一次推理')).toBeInTheDocument()
    expect(within(details).getByText('glm-5.3')).toBeInTheDocument()
    expect(within(details).getByText('本轮累计')).toBeInTheDocument()
    expect(within(details).getByText('13,364')).toBeInTheDocument()
    expect(within(details).getByText('8,210')).toBeInTheDocument()
    expect(within(details).getByText('平均缓存命中率')).toBeInTheDocument()
    expect(within(details).getByText('82.1%')).toBeInTheDocument()
    expect(within(details).getByText('已完成请求 · 按输入 token 加权')).toBeInTheDocument()
    expect(within(details).queryByText(/缓存占总量|61%/)).not.toBeInTheDocument()
    expect(within(details).getByText('本地估算')).toBeInTheDocument()
    const categories = [
      ['消息', '≈ 6,500', '65.0%'], ['系统工具', '≈ 2,100', '21.0%'], ['其他', '≈ 400', '4.0%'],
      ['技能', '≈ 300', '3.0%'], ['系统提示词', '≈ 500', '5.0%'], ['MCP 工具', '≈ 200', '2.0%'],
    ]
    let totalPercent = 0
    for (const [label, count, percent] of categories) {
      const row = within(details).getByText(label!).parentElement!
      expect(within(row).getByText(count!)).toBeInTheDocument()
      expect(within(row).getByText(percent!)).toBeInTheDocument()
      totalPercent += Number(percent!.slice(0, -1))
    }
    expect(totalPercent).toBe(100)
  })

  it('明确报告的零保留，环与进度条为零', () => {
    render(<ChatUsageIndicator timeline={snapshot({ contextUsage: { modelRequestId: 'r', model: 'glm', totalTokens: 0, contextTokens: 100 }, usage: { calls: 0, resultBytes: 0, actualTokens: 0, cachedTokens: 0 }, cacheHitUsage: { inputTokens: 0, cachedTokens: 0 } })} />)
    const details = show()
    expect(within(details).getByText('0 / 100（0.0%）')).toBeInTheDocument()
    expect(within(details).getByRole('meter')).toHaveAttribute('aria-valuenow', '0')
    expect(within(details).getAllByText('0')).toHaveLength(2)
    expect(within(details).getByText('未报告')).toBeInTheDocument()
    expect(within(details).queryByText('缓存占总量')).not.toBeInTheDocument()
  })

  it('上下文超限时环与进度条封顶，实际数字和百分比不截断', () => {
    render(<ChatUsageIndicator timeline={snapshot({ contextUsage: { modelRequestId: 'r', model: 'glm', totalTokens: 150, contextTokens: 100 } })} />)
    expect(screen.getByRole('button').querySelector('.chat-usage-ring')).toHaveStyle('--chat-usage-progress: 100%')
    const details = show()
    expect(within(details).getByText('150 / 100（150.0%）')).toBeInTheDocument()
    expect(within(details).getByRole('meter')).toHaveAttribute('aria-valuenow', '100')
  })

  it.each([
    undefined,
    snapshot({ contextUsage: undefined, usage: undefined, cacheHitUsage: undefined }),
    snapshot({ contextUsage: { modelRequestId: 'r', model: 'glm', contextTokens: 100 }, usage: { calls: 0, resultBytes: 0, tokens: 500, estimatedTokens: 800 }, cacheHitUsage: undefined }),
    snapshot({ contextUsage: { modelRequestId: 'r', model: 'glm', totalTokens: 10, contextTokens: 0 }, usage: undefined, cacheHitUsage: undefined }),
  ])('未知上下文或零容量时圆环保持中性，不回落到累计或估算用量 %j', timeline => {
    render(<ChatUsageIndicator timeline={timeline} />)
    expect(screen.getByRole('button').querySelector('.chat-usage-ring')).not.toHaveAttribute('data-known')
    const details = show()
    expect(within(details).queryByRole('meter')).not.toBeInTheDocument()
    expect(within(details).queryByText(/NaN|Infinity|500|800/)).not.toBeInTheDocument()
    expect(within(details).queryByText('本轮累计')).not.toBeInTheDocument()
  })

  it.each([
    [{ actualTokens: 13364 }, undefined, ['13,364'], '未报告'],
    [{ cachedTokens: 8210 }, undefined, ['8,210'], '未报告'],
    [{ actualTokens: 1, cachedTokens: 2 }, undefined, ['1', '2'], '未报告'],
    [{ actualTokens: 3, cachedTokens: 2 }, { inputTokens: 10, cachedTokens: 3 }, ['3', '2'], '30.0%'],
    [{ actualTokens: 100, cachedTokens: 0 }, { inputTokens: 100, cachedTokens: 0 }, ['100', '0'], '0.0%'],
    [{}, { inputTokens: 100, cachedTokens: 100 }, [], '100.0%'],
    [{}, { inputTokens: 0, cachedTokens: 0 }, [], '未报告'],
  ] satisfies readonly [Partial<RuntimeUsage>, AgentChatCacheHitUsage | undefined, string[], string][])('平均命中率仅使用已报告的输入与缓存总量 %j', (usage: Partial<RuntimeUsage>, cacheHitUsage, values, expected) => {
    render(<ChatUsageIndicator timeline={snapshot({ contextUsage: undefined, usage: { calls: 0, resultBytes: 0, ...usage }, cacheHitUsage })} />)
    const details = show()
    for (const value of values) expect(within(details).getByText(value)).toBeInTheDocument()
    const meanRow = within(details).getByText('平均缓存命中率').parentElement!
    expect(within(meanRow).getByText(expected)).toBeInTheDocument()
    expect(within(details).queryByText('缓存占总量')).not.toBeInTheDocument()
    expect(!!within(details).queryByText('已完成请求 · 按输入 token 加权')).toBe(expected !== '未报告')
    if (usage.actualTokens === undefined) expect(within(details).queryByText('tokens', { exact: true })).not.toBeInTheDocument()
    if (usage.cachedTokens === undefined) expect(within(details).queryByText('缓存 tokens')).not.toBeInTheDocument()
  })

  it('旧记录缺少分类时明确未采集，不按正文关键词推断分类', () => {
    render(<ChatUsageIndicator timeline={snapshot({ contextUsage: { modelRequestId: 'old', model: '消息 系统工具 技能 MCP 工具', totalTokens: 100, contextTokens: 1000 } })} />)
    const details = show()
    expect(within(details).getByText('分类占用未采集')).toBeInTheDocument()
    expect(within(details).queryByText('本地估算')).not.toBeInTheDocument()
    expect(within(details).queryByText(/^≈ /)).not.toBeInTheDocument()
    expect(within(details).queryByText('消息', { exact: true })).not.toBeInTheDocument()
  })

  it('六类明确零值保留估算行，不生成除零百分比', () => {
    render(<ChatUsageIndicator timeline={snapshot({ contextUsage: { ...chatTestContextUsage, estimatedBreakdown: { messages: 0, systemTools: 0, other: 0, skills: 0, systemPrompt: 0, mcpTools: 0 } } })} />)
    const details = show()
    expect(within(details).getAllByText('≈ 0')).toHaveLength(6)
    const breakdown = within(details).getByText('分类占用').parentElement!
    expect(within(breakdown).queryByText(/\d+\.\d+%/)).not.toBeInTheDocument()
    expect(within(details).queryByText(/NaN|Infinity/)).not.toBeInTheDocument()
  })

  it('生成中同样显示已确认请求用量，终态快照更新后原位刷新', () => {
    const view = render(<ChatUsageIndicator timeline={snapshot({ status: 'running', done: false })} />)
    const details = show()
    view.rerender(<ChatUsageIndicator timeline={snapshot({ status: 'running', done: false, usage: { calls: 3, resultBytes: 4096, modelRequests: 4, tokens: 99999 } })} />)
    expect(screen.getByRole('dialog')).toBe(details)
    expect(within(details).getByText('82.1%')).toBeInTheDocument()
    expect(within(details).getByText('36,200 / 100,000（36.2%）')).toBeInTheDocument()
    view.rerender(<ChatUsageIndicator timeline={snapshot({ contextUsage: { modelRequestId: 'request-3', model: 'glm-5.3', totalTokens: 40000, contextTokens: 100000 } })} />)
    expect(screen.getByRole('dialog')).toBe(details)
    expect(within(details).getByText('40,000 / 100,000（40.0%）')).toBeInTheDocument()
    expect(within(details).queryByText('36,200 / 100,000（36.2%）')).not.toBeInTheDocument()
  })

  it('鼠标可以从圆环移入浮层，离开两处后收起', () => {
    vi.useFakeTimers()
    render(<ChatUsageIndicator timeline={snapshot()} />)
    const details = show()
    fireEvent.pointerLeave(screen.getByRole('button'), { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(80))
    fireEvent.pointerEnter(details, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(200))
    expect(details).toBeInTheDocument()
    fireEvent.pointerLeave(details, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(150))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('键盘聚焦展开但不抢焦点，Escape 关闭，Tab 移出后收起', async () => {
    const user = userEvent.setup()
    render(<><ChatUsageIndicator timeline={snapshot()} /><button type="button">下一个控件</button></>)
    const trigger = screen.getByRole('button', { name: '上下文用量' })
    await user.tab()
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(trigger).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    await user.tab()
    await user.tab({ shift: true })
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await user.tab()
    expect(screen.getByRole('button', { name: '下一个控件' })).toHaveFocus()
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('触屏点击可以展开和收起，点击外部也可关闭', async () => {
    const user = userEvent.setup()
    render(<><ChatUsageIndicator timeline={snapshot()} /><button type="button">外部</button></>)
    const trigger = screen.getByRole('button', { name: '上下文用量' })
    await user.pointer([{ keys: '[TouchA>]', target: trigger }, { keys: '[/TouchA]' }])
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await user.pointer([{ keys: '[TouchA>]', target: trigger }, { keys: '[/TouchA]' }])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.pointer([{ keys: '[TouchA>]', target: trigger }, { keys: '[/TouchA]' }])
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '外部' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
