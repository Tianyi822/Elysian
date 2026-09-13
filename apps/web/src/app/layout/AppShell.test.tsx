import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway } from '../../contracts/adapters'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { renderApp } from '../../test/renderApp'
import { NAV_ITEMS } from '../navigation'

beforeEach(() => {
  useEventStreamStore.getState().disconnect()
  useEventStreamStore.setState({ status: 'connecting', recent: [], receivedCount: 0 })
})

describe('模板外壳', () => {
  it('侧边栏只有仪表盘一项', () => {
    renderApp('/')
    const nav = screen.getByRole('navigation', { name: '主导航' })
    const links = within(nav).getAllByRole('link')
    expect(links).toHaveLength(NAV_ITEMS.length)
    expect(links.map((link) => link.textContent)).toEqual(['仪表盘'])
    expect(links[0]).toHaveAttribute('aria-current', 'page')
  })

  it('顶栏含品牌、标题、功能副标题与右侧三个功能位', async () => {
    renderApp('/')
    expect(screen.getByText('Elysian')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: '仪表盘' })).toBeInTheDocument()
    expect(screen.getByText('运维态势概览')).toBeInTheDocument()
    expect(screen.getByText('演示数据·未连接真实基础设施')).toBeInTheDocument()
    expect(screen.getByText('运维人员')).toBeInTheDocument()
    expect(await screen.findByText('实时事件流：已连接')).toBeInTheDocument()
  })

  it('侧边栏底部主题切换在深浅之间切换', async () => {
    const user = userEvent.setup()
    renderApp('/')

    expect(document.documentElement.dataset['theme']).toBe('dark')
    await user.click(screen.getByRole('button', { name: '浅色模式' }))
    expect(document.documentElement.dataset['theme']).toBe('light')
    expect(screen.getByRole('button', { name: '深色模式' })).toBeInTheDocument()
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
})
