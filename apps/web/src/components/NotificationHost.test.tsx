import * as Tooltip from '@radix-ui/react-tooltip'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotificationStore } from '../stores/notificationStore'
import { NotificationHost } from './NotificationHost'

function renderHost() {
  return render(
    <Tooltip.Provider delayDuration={0}>
      <NotificationHost />
    </Tooltip.Provider>,
  )
}

beforeEach(() => {
  useNotificationStore.getState().clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('通知宿主', () => {
  it('没有通知时不占位', () => {
    renderHost()
    expect(screen.queryByLabelText('通知')).not.toBeInTheDocument()
  })

  it('成功与失败分别用 status 与 alert 表达，文案与颜色之外还有图标与关闭按钮', () => {
    useNotificationStore.getState().notify({ tone: 'success', message: '已切换到浅色主题。' })
    useNotificationStore.getState().notify({ tone: 'danger', message: '重置演示数据失败' })
    renderHost()

    const region = screen.getByLabelText('通知')
    const items = within(region).getAllByRole('listitem')
    expect(items).toHaveLength(2)

    const success = within(region).getByRole('status')
    expect(success).toHaveTextContent('已切换到浅色主题。')
    expect(success.querySelector('svg')).not.toBeNull()

    const danger = within(region).getByRole('alert')
    expect(danger).toHaveTextContent('重置演示数据失败')
    expect(within(danger).getByRole('button', { name: '关闭通知' })).toBeInTheDocument()
  })

  it('点关闭按钮只移除那一条', async () => {
    const user = userEvent.setup()
    useNotificationStore.getState().notify({ tone: 'info', message: '留下的' })
    useNotificationStore.getState().notify({ tone: 'info', message: '撤掉的' })
    renderHost()

    const region = screen.getByLabelText('通知')
    const second = within(region).getAllByRole('status')[1] as HTMLElement
    await user.click(within(second).getByRole('button', { name: '关闭通知' }))

    expect(screen.queryByText('撤掉的')).not.toBeInTheDocument()
    expect(screen.getByText('留下的')).toBeInTheDocument()
  })

  it('到时自动消失，失败类留得更久', () => {
    vi.useFakeTimers()
    useNotificationStore.getState().notify({ tone: 'success', message: '成功提示' })
    useNotificationStore.getState().notify({ tone: 'danger', message: '失败提示' })
    renderHost()

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.queryByText('成功提示')).not.toBeInTheDocument()
    expect(screen.getByText('失败提示')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.queryByText('失败提示')).not.toBeInTheDocument()
    // 全部消失后通知区一起收掉。
    expect(screen.queryByLabelText('通知')).not.toBeInTheDocument()
  })
})
