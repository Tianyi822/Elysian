import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { renderApp } from '../../test/renderApp'
import { NAV_ITEMS } from '../navigation'

beforeEach(() => {
  useEventStreamStore.getState().disconnect()
  useEventStreamStore.setState({ status: 'connecting', recent: [], receivedCount: 0 })
  // 主题切换会写偏好存储：不清的话，前一条用例的选择会让后一条多出一个动作。
  localStorage.clear()
  delete document.documentElement.dataset['theme']
})

describe('模板外壳', () => {
  it('侧边栏包含仪表盘、安全、Docker、数据库、文件管理、平台日志与终端七项', () => {
    renderApp('/')
    const nav = screen.getByRole('navigation', { name: '主导航' })
    const links = within(nav).getAllByRole('link')
    expect(links).toHaveLength(NAV_ITEMS.length)
    expect(links.map((link) => link.textContent)).toEqual([
      '仪表盘',
      '安全',
      'Docker',
      '数据库',
      '文件管理',
      '平台日志',
      '终端',
    ])
    expect(links[0]).toHaveAttribute('aria-current', 'page')
  })

  it('点击 Docker 入口切换到容器页，页签占据标题位', async () => {
    const user = userEvent.setup()
    renderApp('/')

    await user.click(screen.getByRole('link', { name: 'Docker' }))

    expect(await screen.findByRole('group', { name: '视图切换' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Docker' })).toHaveAttribute('aria-current', 'page')
  })

  it('点击数据库入口进入数据库卡片页，页签占据标题位', async () => {
    const user = userEvent.setup()
    renderApp('/')

    await user.click(screen.getByRole('link', { name: '数据库' }))

    expect(await screen.findByRole('group', { name: '数据库类型' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '数据库' })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByRole('region', { name: '数据库实例' })).toBeInTheDocument()
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

  it('主题快捷操作在深浅之间切换，主题变化本身即反馈，不再发通知', async () => {
    const user = userEvent.setup()
    renderApp('/')

    expect(document.documentElement.dataset['theme']).toBe('dark')
    await user.click(screen.getByRole('button', { name: /切换到浅色主题/ }))
    expect(document.documentElement.dataset['theme']).toBe('light')
    expect(screen.getByRole('button', { name: /切换到深色主题/ })).toBeInTheDocument()

    expect(screen.queryByLabelText('通知')).not.toBeInTheDocument()
  })

  it('存过主题偏好后出现「跟随系统主题」动作，点它清掉偏好并回到系统档', async () => {
    const user = userEvent.setup()
    renderApp('/')
    const section = screen.getByLabelText('快捷操作')
    expect(within(section).queryByRole('button', { name: /跟随系统主题/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /切换到浅色主题/ }))
    expect(localStorage.getItem('elysian.ui-preferences')).toContain('"theme":"light"')

    // 跟随入口是主题项行内的图标按钮，不再是一条独立动作：与主题切换同处一个行容器。
    const followButton = within(section).getByRole('button', { name: '跟随系统主题' })
    const themeButton = within(section).getByRole('button', { name: /切换到(浅色|深色)主题/ })
    expect(followButton.parentElement).toBe(themeButton.parentElement)
    expect(within(followButton.parentElement as HTMLElement).getAllByRole('button')).toHaveLength(2)

    // 系统档显式置为深色（jsdom 默认报浅色），否则断言看不出回落方向。
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }))
    await user.click(within(section).getByRole('button', { name: /跟随系统主题/ }))

    expect(localStorage.getItem('elysian.ui-preferences')).toBeNull()
    expect(document.documentElement.dataset['theme']).toBe('dark')
    expect(within(section).queryByRole('button', { name: /跟随系统主题/ })).not.toBeInTheDocument()
    vi.unstubAllGlobals()
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
