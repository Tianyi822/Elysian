import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway } from '../../contracts/adapters'
import { renderApp } from '../../test/renderApp'
import { NAV_ITEMS } from '../navigation'

describe('应用外壳', () => {
  it('侧边栏按配置呈现全部导航项', () => {
    renderApp('/')
    const nav = screen.getByRole('navigation', { name: '主导航' })
    const labels = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent)
    expect(labels).toEqual(NAV_ITEMS.map((item) => item.label))
  })

  it('当前路由在侧边栏里被标记为当前页', () => {
    renderApp('/approvals')
    expect(screen.getByRole('link', { name: '审批队列' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('每个页面都常驻演示数据标识', () => {
    renderApp('/')
    expect(screen.getByText('演示数据·未连接真实基础设施')).toBeInTheDocument()
  })

  it('标识事件流状态：默认网关用内存事件源，显示已连接', async () => {
    renderApp('/')
    expect(await screen.findByText('实时事件流：已连接')).toBeInTheDocument()
  })

  it('事件源不可用时，标识明确写出已降级', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const degraded: ElysianGateway = {
      ...base,
      events: {
        subscribe(handlers) {
          handlers.onStatus('degraded')
          return () => {}
        },
      },
    }

    renderApp('/', { gateway: degraded })
    expect(await screen.findByText('实时事件流：已降级为内存事件源')).toBeInTheDocument()
  })

  it('主题切换在深色与浅色之间切换 html 标记', async () => {
    const user = userEvent.setup()
    renderApp('/')

    expect(document.documentElement.dataset['theme']).toBe('dark')

    await user.click(screen.getByRole('button', { name: '切换到浅色主题' }))
    expect(document.documentElement.dataset['theme']).toBe('light')

    await user.click(screen.getByRole('button', { name: '切换到深色主题' }))
    expect(document.documentElement.dataset['theme']).toBe('dark')
  })

  it('窄屏抽屉可以打开导航并关闭', async () => {
    const user = userEvent.setup()
    renderApp('/')

    await user.click(screen.getByRole('button', { name: '打开主导航' }))
    const drawer = screen.getByRole('dialog', { name: '主导航' })
    expect(within(drawer).getAllByRole('link')).toHaveLength(NAV_ITEMS.length)

    await user.click(screen.getByRole('button', { name: '关闭主导航' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
