import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { renderApp } from '../../test/renderApp'

/** 平铺形态的容器：宽度够时它参与标签栏布局，摆不下时整体隐藏。 */
function tabSlot(): HTMLElement {
  return screen.getByRole('tablist', { name: '终端会话' }).parentElement as HTMLElement
}

function sessionTrigger(): HTMLElement {
  return screen.getByRole('button', { name: /终端会话/ })
}

beforeEach(() => {
  useTerminalsStore.getState().resetLocal()
})

describe('终端页', () => {
  it('进入页面自动开一条本机会话，提示符可用', async () => {
    renderApp('/terminals')
    expect(await screen.findByRole('tablist', { name: '终端会话' })).toBeInTheDocument()
    expect(await screen.findByRole('tab', { name: /ops@elysian-demo/ })).toBeInTheDocument()
    const panel = await screen.findByRole('tabpanel')
    expect(within(panel).queryByText('演示终端 · 待接入真实执行')).not.toBeInTheDocument()
    expect(screen.getByText('演示终端 · 待接入真实执行')).toBeInTheDocument()
    const input = await screen.findByLabelText('命令输入')
    expect(document.activeElement).toBe(input)
    expect(screen.getByRole('log')).toHaveTextContent('ops@elysian-demo:~$')
  })

  it('回车执行 whoami，日志回显提示符与输出', async () => {
    const user = userEvent.setup()
    renderApp('/terminals')
    const input = await screen.findByLabelText('命令输入')
    await user.type(input, 'whoami{Enter}')
    expect(await screen.findByText('ops@elysian-demo:~$ whoami')).toBeInTheDocument()
    expect(screen.getByRole('log')).toHaveTextContent(/\bops\b/)
  })

  it('新建标签后切换，各自保留已提交的历史', async () => {
    const user = userEvent.setup()
    renderApp('/terminals')
    const firstInput = await screen.findByLabelText('命令输入')
    await user.type(firstInput, 'hostname{Enter}')
    expect(await screen.findByText('ops@elysian-demo:~$ hostname')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '新建终端' }))
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['ops@elysian-demo 1', 'ops@elysian-demo 2'])

    await waitFor(() => expect(screen.queryByText('ops@elysian-demo:~$ hostname')).not.toBeInTheDocument())

    await user.click(screen.getByRole('tab', { name: 'ops@elysian-demo 1' }))
    expect(await screen.findByText('ops@elysian-demo:~$ hostname')).toBeInTheDocument()
  })

  it('关闭标签先确认，关光后进入空状态', async () => {
    const user = userEvent.setup()
    renderApp('/terminals')
    await screen.findByLabelText('命令输入')

    await user.click(screen.getByRole('button', { name: '关闭 ops@elysian-demo' }))
    const confirm = await screen.findByRole('dialog', { name: '确认关闭终端？' })
    expect(confirm.textContent).toContain('会话历史将不再保留')
    await user.click(within(confirm).getByRole('button', { name: '继续使用' }))
    expect(screen.getByLabelText('命令输入')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '关闭 ops@elysian-demo' }))
    await user.click(await screen.findByRole('button', { name: '确认关闭' }))
    expect(await screen.findByText('还没有终端会话')).toBeInTheDocument()
    expect(screen.queryByLabelText('命令输入')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建终端' })).toBeInTheDocument()
  })

  it('主区贴边：无顶栏，main 去掉内边距', async () => {
    const { container } = renderApp('/terminals')
    await screen.findByRole('tablist', { name: '终端会话' })
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开主导航' })).toBeInTheDocument()
    const main = container.querySelector('main')
    expect(main?.className).toContain('overflow-hidden')
    expect(main?.className).not.toMatch(/\bp-4\b/)
  })

  it('放得下时平铺标签，只藏下拉', async () => {
    // jsdom 量不出任何宽度，按「放得下」处理：平铺参与布局，下拉只在收起时出场。
    renderApp('/terminals')
    await screen.findByRole('tablist', { name: '终端会话' })

    expect(tabSlot()).not.toHaveClass('hidden')
    expect(sessionTrigger()).toHaveClass('hidden')
  })

  it('标签挤不下时改显自绘下拉', async () => {
    // 判断依据是真实宽度，jsdom 里一切尺寸都是 0：把平铺探针量成装不下的宽度，
    // 等价于「标签已经顶到右侧功能簇」，此时应让位收成下拉。
    const original = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const rect = original.call(this)
      if (this.classList.contains('w-max') && this.querySelector('[role="tab"]')) {
        Object.defineProperty(rect, 'width', { value: 800 })
      }
      return rect
    })

    try {
      renderApp('/terminals')
      await screen.findByLabelText('命令输入')

      expect(tabSlot()).toHaveClass('hidden')
      expect(sessionTrigger()).not.toHaveClass('hidden')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('下拉里可选会话并切换，各自保留已提交的历史', async () => {
    const user = userEvent.setup()
    renderApp('/terminals')
    const firstInput = await screen.findByLabelText('命令输入')
    await user.type(firstInput, 'hostname{Enter}')
    expect(await screen.findByText('ops@elysian-demo:~$ hostname')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '新建终端' }))
    await screen.findByRole('tab', { name: 'ops@elysian-demo 2' })

    await user.click(sessionTrigger())
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.map((option) => option.textContent)).toEqual([
      'ops@elysian-demo 1',
      'ops@elysian-demo 2',
    ])

    await user.click(screen.getByRole('menuitemradio', { name: 'ops@elysian-demo 1' }))
    expect(await screen.findByText('ops@elysian-demo:~$ hostname')).toBeInTheDocument()
  })

  it('Ctrl+C 经 gateway 的 interrupt 接缝发出并落本地 ^C 外观', async () => {
    const user = userEvent.setup()
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const interrupt = vi.fn(async () => {})
    // 类实例不能靠展开覆盖（方法在原型上）：逐字段显式装配。
    const gateway = {
      ...base,
      terminals: {
        connect: (handlers: Parameters<typeof base.terminals.connect>[0]) =>
          base.terminals.connect(handlers),
        sendInput: (id: string, line: string) => base.terminals.sendInput(id, line),
        interrupt,
        complete: (id: string, draft: string, cursor: number) =>
          base.terminals.complete(id, draft, cursor),
        disconnect: (id: string) => base.terminals.disconnect(id),
      },
    }
    renderApp('/terminals', { gateway })

    const input = await screen.findByLabelText('命令输入')
    await user.type(input, 'sleep 30{Control>}c{/Control}')
    expect(screen.getByRole('log')).toHaveTextContent('ops@elysian-demo:~$ sleep 30^C')
    await waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1))
  })
})
