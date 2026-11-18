import * as Tooltip from '@radix-ui/react-tooltip'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { platformMemorySample } from '../test/platformMemorySample'
import type { PlatformMemoryView } from '../stores/systemLoadStore'
import { SystemLoadBadge } from './SystemLoadBadge'

const load = { m1: 0.42, m5: 0.18, m15: 0.07 }

function renderBadge(memory: PlatformMemoryView, { hasLoad = true, navigation = false } = {}) {
  render(<Tooltip.Provider><SystemLoadBadge memory={memory} load={hasLoad ? load : undefined} navigation={navigation} /></Tooltip.Provider>)
  return screen.getByRole('button', { name: '系统负载' })
}

function renderReady(sample = platformMemorySample()) {
  return renderBadge({ status: 'ready', sample })
}

describe('系统负载徽标', () => {
  it('没收到事件流采样时负载显示占位，不当成 0', async () => {
    const trigger = renderBadge({ status: 'ready', sample: platformMemorySample() }, { hasLoad: false })

    expect(trigger).toHaveTextContent('80.0 MiB')
    expect(trigger).toHaveTextContent('—')
    expect(trigger).not.toHaveTextContent('0.00')

    const user = userEvent.setup()
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '系统负载明细' })
    expect(within(dialog).getByText(/还没收到事件流的资源采样/)).toBeInTheDocument()
  })

  it('常驻 1 分钟负载与内存用量，不显示百分比', () => {
    const trigger = renderReady()

    expect(trigger).toHaveTextContent('0.42')
    expect(trigger).toHaveTextContent('80.0 MiB')
    expect(trigger).not.toHaveTextContent('%')
    // 5/15 分钟档不进常驻读数，只出现在明细里
    expect(trigger).not.toHaveTextContent('0.18')
  })

  it('侧栏负载明细使用 Peek Card，保留失败说明，Escape 关闭并归还焦点', async () => {
    const trigger = renderBadge({ status: 'error' }, { navigation: true })
    const user = userEvent.setup()
    await user.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: '系统负载明细' })
    expect(dialog).toHaveAttribute('data-easyui', 'peek-card')
    expect(within(dialog).getByText('后端进程内存读取失败，稍后会再试。')).toBeInTheDocument()
    expect(dialog.querySelector('polygon')).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('明细常驻三档负载和 RSS，Go 运行时默认折叠且可用键盘切换', async () => {
    const trigger = renderReady()

    const user = userEvent.setup()
    await user.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: '系统负载明细' })
    expect(within(dialog).getByText('机器负载（load average）')).toBeInTheDocument()
    expect(within(dialog).getByText('0.42')).toBeInTheDocument()
    expect(within(dialog).getByText('0.18')).toBeInTheDocument()
    expect(within(dialog).getByText('0.07')).toBeInTheDocument()
    expect(within(dialog).getByText('面板常驻内存（RSS）')).toBeInTheDocument()
    expect(within(dialog).getByText('1.00 GiB')).toBeInTheDocument()
    expect(within(dialog).getByText('占系统总内存')).toBeInTheDocument()
    expect(within(dialog).getByText('7.8%')).toBeInTheDocument()
    const runtime = within(dialog).getByRole('button', { name: 'Go 运行时' })
    expect(runtime).toHaveAttribute('aria-expanded', 'false')
    expect(within(dialog).queryByText('堆预留')).not.toBeInTheDocument()
    runtime.focus()
    await user.keyboard('{Enter}')
    expect(runtime).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => expect(within(dialog).getByText('40.0 MiB')).toBeVisible())
    await user.keyboard('{Enter}')
    expect(runtime).toHaveAttribute('aria-expanded', 'false')
    expect(within(dialog).queryByText('堆预留')).not.toBeInTheDocument()
  })

  it('口径解释在问号浮层里，不常驻明细', async () => {
    const trigger = renderReady()

    const user = userEvent.setup()
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '系统负载明细' })
    expect(within(dialog).queryByText(/不能相加/)).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Go 运行时' }))
    await user.click(within(dialog).getByRole('button', { name: '内存口径说明' }))
    const help = await screen.findByRole('dialog', { name: '内存口径说明' })
    expect(within(help).getByText(/不能相加/)).toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
  })

  it('内存采集失败时如实说明，不伪造数据', () => {
    const trigger = renderBadge({ status: 'error' })

    expect(trigger).toHaveTextContent('采集失败')
    expect(trigger).not.toHaveTextContent(/MiB|%/)
    expect(trigger).toHaveTextContent('0.42')
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  })

  it('近似读数在常驻读数与明细里都明确标注', async () => {
    const trigger = renderReady(platformMemorySample({ rssSource: 'statm' }))

    expect(trigger).toHaveTextContent('≈ 80.0 MiB')

    const user = userEvent.setup()
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '系统负载明细' })
    expect(
      within(dialog).getByRole('meter', { name: '后端常驻内存占系统总内存' }),
    ).toHaveAttribute('aria-valuetext', '≈ 80.0 MiB，占系统总内存的 7.8%')
  })

  it('无法读取实际用量时显示不可用，不用 Go 堆数据冒充', async () => {
    const trigger = renderReady(
      platformMemorySample({ rssMb: null, rssSource: 'unavailable', gcCount: 0, heapLiveMb: 0 }),
    )

    expect(trigger).toHaveTextContent('不可用')
    expect(trigger).not.toHaveTextContent(/MiB|%/)

    const user = userEvent.setup()
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '系统负载明细' })
    expect(within(dialog).queryByRole('meter')).not.toBeInTheDocument()
    expect(within(dialog).getByText('不可用')).toBeInTheDocument()
    expect(within(dialog).getByText('—')).toBeInTheDocument()
  })

  it('参照总量不可读时保留实际大小，不伪造百分比或占用条', async () => {
    const trigger = renderReady(platformMemorySample({ systemTotalMb: null }))

    expect(trigger).toHaveTextContent('80.0 MiB')
    expect(trigger).not.toHaveTextContent('%')

    const user = userEvent.setup()
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '系统负载明细' })
    expect(within(dialog).queryByRole('meter')).not.toBeInTheDocument()
    expect(within(dialog).getAllByText('—')).toHaveLength(2)
    expect(within(dialog).queryByText(/NaN/)).not.toBeInTheDocument()
  })
})
