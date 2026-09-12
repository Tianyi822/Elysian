import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway } from '../../contracts/adapters'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { renderApp } from '../../test/renderApp'

beforeEach(() => {
  useEventStreamStore.getState().disconnect()
  useEventStreamStore.setState({ status: 'connecting', recent: [], receivedCount: 0 })
})

function createGateway() {
  return createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
}

describe('系统设置', () => {
  it('设置页的主题切换与页头入口共用同一状态', async () => {
    const user = userEvent.setup()
    renderApp('/settings')
    await screen.findByRole('heading', { level: 2, name: '外观' })

    expect(document.documentElement.dataset['theme']).toBe('dark')
    expect(screen.getByRole('radio', { name: '深色' })).toBeChecked()
    expect(screen.getByRole('button', { name: '切换到浅色主题' })).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: '浅色' }))

    expect(document.documentElement.dataset['theme']).toBe('light')
    // 页头按钮随之变为「切换到深色主题」，说明两处是同一个设置
    expect(await screen.findByRole('button', { name: '切换到深色主题' })).toBeInTheDocument()
  })

  it('显示事件源连接状态', async () => {
    renderApp('/settings')
    await screen.findByRole('heading', { level: 2, name: '事件源' })
    expect(await screen.findByText('已连接')).toBeInTheDocument()
  })

  it('事件源降级时明确说明降级的含义', async () => {
    const base = createGateway()
    const degraded: ElysianGateway = {
      ...base,
      events: {
        subscribe(handlers) {
          handlers.onStatus('degraded')
          return () => {}
        },
      },
    }

    renderApp('/settings', { gateway: degraded })
    await screen.findByRole('heading', { level: 2, name: '事件源' })

    expect(await screen.findByText('已降级为内存事件源')).toBeInTheDocument()
    expect(screen.getByText(/界面上的增量来自进程内的内存事件源/)).toBeInTheDocument()
  })

  it('重置演示数据需要二次确认，确认后给出结果反馈', async () => {
    const user = userEvent.setup()
    const base = createGateway()
    const reset = vi.fn(async () => {
      await base.reset()
    })

    renderApp('/settings', { gateway: { ...base, reset } })
    await screen.findByRole('heading', { level: 2, name: '演示数据' })

    await user.click(screen.getByRole('button', { name: '重置演示数据' }))

    const dialog = await screen.findByRole('dialog', { name: '确认重置演示数据？' })
    expect(reset).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: '确认重置' }))

    await waitFor(() => expect(reset).toHaveBeenCalledOnce())
    const note = await screen.findByRole('status')
    expect(note).toHaveTextContent('演示数据已重置回种子状态')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('取消确认时不会重置', async () => {
    const user = userEvent.setup()
    const base = createGateway()
    const reset = vi.fn(async () => {
      await base.reset()
    })

    renderApp('/settings', { gateway: { ...base, reset } })
    await screen.findByRole('heading', { level: 2, name: '演示数据' })

    await user.click(screen.getByRole('button', { name: '重置演示数据' }))
    const dialog = await screen.findByRole('dialog', { name: '确认重置演示数据？' })
    await user.click(within(dialog).getByRole('button', { name: '取消' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(reset).not.toHaveBeenCalled()
  })

  it('重置失败时给出明确反馈', async () => {
    const user = userEvent.setup()
    const base = createGateway()
    const reset = vi.fn(async () => {
      throw new Error('演示用的重置失败')
    })

    renderApp('/settings', { gateway: { ...base, reset } })
    await screen.findByRole('heading', { level: 2, name: '演示数据' })

    await user.click(screen.getByRole('button', { name: '重置演示数据' }))
    const dialog = await screen.findByRole('dialog', { name: '确认重置演示数据？' })
    await user.click(within(dialog).getByRole('button', { name: '确认重置' }))

    // 失败提示渲染在弹窗内部：弹窗打开时，外面的内容不在无障碍树里。
    const alert = within(dialog).getByRole('alert')
    expect(alert).toHaveTextContent('重置演示数据失败：演示用的重置失败')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('把未连接的真实系统与待实现能力写清楚', async () => {
    renderApp('/settings')
    await screen.findByRole('heading', { level: 2, name: '本阶段的边界' })

    expect(screen.getByText(/未连接的真实系统/)).toBeInTheDocument()
    expect(screen.getByText(/真实 Kubernetes、SSH、云厂商与数据库/)).toBeInTheDocument()
    expect(screen.getByText(/待实现的能力/)).toBeInTheDocument()
    expect(screen.getByText(/harness 运行时/)).toBeInTheDocument()
  })

  it('表单控件与标签关联，窄屏下不溢出', async () => {
    renderApp('/settings')
    await screen.findByRole('heading', { level: 2, name: '外观' })

    // 单选按钮通过 label 关联，可用可访问名定位
    expect(screen.getByRole('radio', { name: '深色' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '浅色' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '主题' })).toBeInTheDocument()
  })
})
