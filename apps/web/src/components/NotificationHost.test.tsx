import * as Tooltip from '@radix-ui/react-tooltip'
import * as Dialog from '@radix-ui/react-dialog'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useContainersStore } from '../stores/containersStore'
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
  useContainersStore.setState({ detailContainerId: undefined })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('通知宿主', () => {
  it('没有通知时不占位', () => {
    renderHost()
    expect(screen.queryByLabelText('通知')).not.toBeInTheDocument()
    expect(document.querySelector('[aria-live="polite"]')).toBeEmptyDOMElement()
  })

  it('未捕获脚本异常与 Promise 拒绝进入通知，避免重复刷屏并保留浏览器诊断', () => {
    const addListener = vi.spyOn(window, 'addEventListener')
    const removeListener = vi.spyOn(window, 'removeEventListener')
    try {
      const { unmount } = renderHost()
      const onError = addListener.mock.calls.find(([type]) => type === 'error')![1] as EventListener
      const onRejection = addListener.mock.calls.find(([type]) => type === 'unhandledrejection')![1] as EventListener
      const error = new ErrorEvent('error', { cancelable: true, message: 'private-key-in-error', error: new Error('private-key-in-error') })
      act(() => {
        onError(error)
        onRejection(new Event('unhandledrejection'))
      })
      expect(screen.getByRole('alert')).toHaveTextContent('页面操作发生异常，请重试；若仍失败，请刷新页面。')
      expect(useNotificationStore.getState().notifications).toHaveLength(1)
      expect(screen.queryByText(/private-key-in-error/)).toBeNull()
      expect(error.defaultPrevented).toBe(false)

      act(() => useNotificationStore.getState().clear())
      act(() => onRejection(new Event('unhandledrejection')))
      expect(screen.getByRole('alert')).toBeInTheDocument()

      unmount()
      expect(removeListener).toHaveBeenCalledWith('error', onError)
      expect(removeListener).toHaveBeenCalledWith('unhandledrejection', onRejection)
    } finally {
      addListener.mockRestore()
      removeListener.mockRestore()
    }
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

  it('警告用 status 礼貌播报，并有警告图标与颜色', () => {
    useNotificationStore.getState().notify({ tone: 'warning', message: '连接中断，请检查当前状态' })
    renderHost()

    const warning = screen.getByRole('status')
    expect(warning).toHaveTextContent('连接中断，请检查当前状态')
    expect(warning).toHaveClass('border-warning/40')
    expect(warning.querySelector('svg')).toHaveClass('text-warning', 'lucide-triangle-alert')
  })

  it('状态图标钉在左上、关闭按钮钉在右上，都不随内容撑高移动', () => {
    useNotificationStore.getState().notify({ tone: 'success', message: '已切换到浅色主题。' })
    renderHost()

    const card = screen.getByRole('status')
    expect(card).toHaveClass('relative')
    // 行对齐用 flex-start：消息换行把卡片撑高时，左侧图标留在顶部而不是漂到中间。
    expect(card).toHaveClass('items-start')

    // 关闭按钮脱离 flex 流，由独立锚点钉在卡片右上角：内容再高也不改变它的位置。
    const close = within(card).getByRole('button', { name: '关闭通知' })
    const anchor = close.closest('span')
    expect(anchor).not.toBeNull()
    expect(anchor).toHaveClass('absolute')
    expect(anchor).toHaveClass('right-1.5')
    expect(anchor).toHaveClass('top-1.5')

    // 幽灵样式：不带静态边框与底色，弱化为次要色，悬停才浮现可点击感。
    expect(close).toHaveClass('text-fg-subtle')
    expect(close.className).not.toMatch(/(?<!hover:)border-line/)
    expect(close.className).not.toMatch(/(?<!hover:)bg-surface-raised/)
    expect(close).toHaveClass('hover:bg-surface-raised')

    // 文字 14px、行盒 20px，图标 15px 配 3px 偏移与首行居中对齐。
    const icon = card.querySelector('svg')
    expect(icon?.classList.contains('mt-[3px]')).toBe(true)
    expect(icon?.classList.contains('shrink-0')).toBe(true)
    const text = card.querySelector('span')
    expect(text).toHaveClass('text-[14px]')
    expect(text).toHaveClass('leading-5')
  })

  it('容器详情面板打开时通知区左移让位并带过渡，关闭后回到原位', () => {
    useNotificationStore.getState().notify({ tone: 'info', message: '占位' })
    renderHost()

    const region = screen.getByLabelText('通知')
    expect(region).toHaveClass('right-4')
    expect(region).toHaveClass('fixed', 'top-4', 'z-[70]')
    expect(region.parentElement).toBe(document.body)
    expect(region).not.toHaveClass('lg:right-[calc(28rem+1rem)]')
    // 让位靠 right 过渡呈现动画，motion-reduce 下关闭。
    expect(region).toHaveClass('transition-[right]')
    expect(region).toHaveClass('motion-reduce:transition-none')

    act(() => {
      useContainersStore.setState({ detailContainerId: 'ctr-nginx-proxy' })
    })
    expect(region).toHaveClass('lg:right-[calc(28rem+1rem)]')

    act(() => {
      useContainersStore.setState({ detailContainerId: undefined })
    })
    expect(region).not.toHaveClass('lg:right-[calc(28rem+1rem)]')
  })

  it('弹窗打开后产生的通知可见且不被读屏隐藏，关闭通知不关闭弹窗', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Tooltip.Provider>
      <NotificationHost />
      <Dialog.Root>
        <Dialog.Trigger>打开确认窗口</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60]" />
          <Dialog.Content aria-describedby={undefined} className="fixed z-[61]">
            <Dialog.Title>确认操作</Dialog.Title>
            <button type="button" onClick={() => useNotificationStore.getState().notify({ tone: 'danger', message: '操作失败，请重试' })}>执行操作</button>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Tooltip.Provider>)
    await user.click(screen.getByRole('button', { name: '打开确认窗口' }))
    await user.click(screen.getByRole('button', { name: '执行操作' }))
    const region = screen.getByLabelText('通知')
    expect(region.closest('[aria-hidden="true"]')).toBeNull()
    expect(within(region).getByRole('alert')).toHaveTextContent('操作失败，请重试')
    await user.click(within(region).getByRole('button', { name: '关闭通知' }))
    expect(screen.queryByLabelText('通知')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '确认操作' })).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement)
  })

  it('到时自动消失，警告和失败类留得更久', () => {
    vi.useFakeTimers()
    useNotificationStore.getState().notify({ tone: 'success', message: '成功提示' })
    useNotificationStore.getState().notify({ tone: 'warning', message: '警告提示' })
    useNotificationStore.getState().notify({ tone: 'danger', message: '失败提示' })
    renderHost()

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.queryByText('成功提示')).not.toBeInTheDocument()
    expect(screen.getByText('警告提示')).toBeInTheDocument()
    expect(screen.getByText('失败提示')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.queryByText('失败提示')).not.toBeInTheDocument()
    expect(screen.queryByText('警告提示')).not.toBeInTheDocument()
    // 全部消失后通知区一起收掉。
    expect(screen.queryByLabelText('通知')).not.toBeInTheDocument()
  })
})
