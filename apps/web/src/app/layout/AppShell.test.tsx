import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { renderApp } from '../../test/renderApp'
import { NAV_ITEMS } from '../navigation'

beforeEach(() => {
  useEventStreamStore.getState().disconnect()
  useEventStreamStore.setState({ status: 'connecting', recent: [], receivedCount: 0 })
})

describe('模板外壳', () => {
  it('侧边栏包含仪表盘与 Docker 两项', () => {
    renderApp('/')
    const nav = screen.getByRole('navigation', { name: '主导航' })
    const links = within(nav).getAllByRole('link')
    expect(links).toHaveLength(NAV_ITEMS.length)
    expect(links.map((link) => link.textContent)).toEqual(['仪表盘', 'Docker'])
    expect(links[0]).toHaveAttribute('aria-current', 'page')
  })

  it('点击 Docker 入口切换到容器页，顶栏标题跟随变化', async () => {
    const user = userEvent.setup()
    renderApp('/')

    await user.click(screen.getByRole('link', { name: 'Docker' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Docker' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Docker' })).toHaveAttribute('aria-current', 'page')
  })

  it('顶栏含品牌、标题、内存自检与用户占位', async () => {
    renderApp('/')
    expect(screen.getByText('Elysian')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: '仪表盘' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '平台内存占用' })).toBeInTheDocument()
    expect(screen.getByText('运维人员')).toBeInTheDocument()
  })

  it('侧边栏底部快捷操作包含四个动作，反馈不出现在侧边栏里', () => {
    renderApp('/')
    const section = screen.getByLabelText('快捷操作')
    expect(within(section).getByRole('button', { name: /切换到浅色主题/ })).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: /重置演示数据/ })).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: /重新连接事件源/ })).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: /刷新仪表盘/ })).toBeInTheDocument()
    expect(within(section).queryByRole('status')).not.toBeInTheDocument()
  })

  it('侧边栏底部的主题快捷操作在深浅之间切换，反馈走页面右上角通知区', async () => {
    const user = userEvent.setup()
    renderApp('/')

    expect(document.documentElement.dataset['theme']).toBe('dark')
    await user.click(screen.getByRole('button', { name: /切换到浅色主题/ }))
    expect(document.documentElement.dataset['theme']).toBe('light')
    expect(screen.getByRole('button', { name: /切换到深色主题/ })).toBeInTheDocument()

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent('已切换到浅色主题。')
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

  it('桌面侧边栏可以收起并展开', async () => {
    const user = userEvent.setup()
    renderApp('/')

    const collapse = screen.getByRole('button', { name: '收起侧边栏' })
    await user.click(collapse)
    expect(screen.getByRole('button', { name: '展开侧边栏' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '展开侧边栏' }))
    expect(screen.getByRole('button', { name: '收起侧边栏' })).toBeInTheDocument()
  })
})
