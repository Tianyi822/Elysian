import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { useSessionStore } from '../../stores/sessionStore'
import { renderApp } from '../../test/renderApp'
import { NAV_ITEMS } from '../navigation'
import { moveNavItem } from '../navigationOrder'
import { writeStoredNavOrder } from '../theme/themePreferences'

beforeEach(() => {
  useEventStreamStore.getState().disconnect()
  useEventStreamStore.setState({ status: 'connecting', recent: [], receivedCount: 0 })
  // 主题切换会写偏好存储：不清的话，前一条用例的选择会让后一条多出一个动作。
  localStorage.clear()
  delete document.documentElement.dataset['theme']
})

describe('模板外壳', () => {
  it('侧边栏包含仪表盘、安全、Docker、数据库、文件管理、平台日志、终端、网站与设置九项', () => {
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
      '网站',
      '设置',
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
    // 数据库域固定走 http adapter（jsdom 下 fetch 不可达），与 DatabasePage 测试同法注入自建 fake，
    // 否则页面停在错误态，「数据库实例」区不会出现；本用例只验证导航落位，列表给空即可。
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    renderApp('/', {
      gateway: {
        ...base,
        databases: {
          async list() {
            return []
          },
          async create() {
            throw new Error('本用例不创建数据库')
          },
          async remove() {},
        },
      },
    })

    await user.click(screen.getByRole('link', { name: '数据库' }))

    expect(await screen.findByRole('group', { name: '数据库类型' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '数据库' })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByRole('region', { name: '数据库实例' })).toBeInTheDocument()
  })

  it('顶栏含品牌、标题与内存自检，不含运维人员', async () => {
    renderApp('/')
    const header = screen.getByRole('banner')
    expect(screen.getByText('Elysian')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: '仪表盘' })).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: '平台内存占用' })).toBeInTheDocument()
    expect(within(header).queryByText('运维人员')).not.toBeInTheDocument()
  })

  it('侧边栏底部只保留切换主题，其下显示运维人员', () => {
    renderApp('/')
    const section = screen.getByLabelText('快捷操作')
    expect(within(section).getByRole('button', { name: /切换到浅色主题/ })).toBeInTheDocument()
    expect(within(section).getByText('运维人员')).toBeInTheDocument()
    expect(within(section).queryByRole('button', { name: /重置演示数据/ })).not.toBeInTheDocument()
    expect(within(section).queryByRole('button', { name: /重新连接事件源/ })).not.toBeInTheDocument()
    expect(within(section).queryByRole('button', { name: /刷新仪表盘/ })).not.toBeInTheDocument()
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

  it('拖拽手柄默认隐藏，指针离开该项后不再显示', async () => {
    const user = userEvent.setup()
    renderApp('/')
    const nav = screen.getByRole('navigation', { name: '主导航' })
    const handles = within(nav).getAllByRole('button', { name: /拖拽排序：/ })
    expect(handles).toHaveLength(NAV_ITEMS.length - 1)
    expect(within(nav).queryByRole('button', { name: '拖拽排序：仪表盘' })).not.toBeInTheDocument()
    for (const handle of handles) {
      expect(handle.parentElement).toHaveClass('opacity-0')
    }

    const logs = within(nav).getByRole('link', { name: '平台日志' })
    await user.hover(logs)
    expect(within(nav).getByRole('button', { name: '拖拽排序：平台日志' }).parentElement).toHaveClass(
      'opacity-100',
    )
    expect(within(nav).queryByRole('button', { name: '拖拽排序：仪表盘' })).not.toBeInTheDocument()

    await user.unhover(logs)
    expect(within(nav).getByRole('button', { name: '拖拽排序：平台日志' }).parentElement).toHaveClass(
      'opacity-0',
    )
    expect(within(nav).getByRole('button', { name: '拖拽排序：平台日志' }).parentElement).not.toHaveClass(
      'opacity-100',
    )
  })

  it('拖拽时其余项按身位让开，松手后顺序写入本地并在重新进入后保持', () => {
    const { unmount } = renderApp('/')
    const nav = screen.getByRole('navigation', { name: '主导航' })
    const restore = installNavRects()
    const handle = within(nav).getByRole('button', { name: '拖拽排序：安全' })

    try {
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 64 })
      fireEvent.pointerMove(window, { pointerId: 1, clientY: 63 })
      expect(nav.querySelector<HTMLElement>('[data-nav-item="/"]')?.style.transform).toBe('')
      expect(nav.querySelector<HTMLElement>('[data-nav-item="/docker"]')?.style.transform).toBe('')

      fireEvent.pointerMove(window, { pointerId: 1, clientY: 87 })
      expect(nav.querySelector<HTMLElement>('[data-nav-item="/docker"]')?.style.transform).toBe('')

      fireEvent.pointerMove(window, { pointerId: 1, clientY: 120 })

      const shifted = nav.querySelector<HTMLElement>('[data-nav-item="/docker"]')
      const dragged = nav.querySelector<HTMLElement>('[data-nav-item="/security"]')
      expect(shifted?.style.transform).toBe('translateY(-44px)')
      expect(shifted?.className).toContain('transition-transform')
      expect(dragged?.style.transform).toBe('translateY(56px)')
      expect(dragged?.className).not.toContain('transition-transform')
      expect(nav.querySelector<HTMLElement>('[data-nav-item="/"]')?.style.transform).toBe('')

      fireEvent.pointerUp(window, { pointerId: 1, clientY: 120 })
    } finally {
      restore()
    }

    const expected = moveNavItem(
      NAV_ITEMS.map((item) => item.to),
      1,
      2,
    )
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(
      expected?.map((path) => NAV_ITEMS.find((item) => item.to === path)?.label),
    )
    expect(JSON.parse(localStorage.getItem('elysian.ui-preferences') ?? '{}').nav).toEqual(expected)
    if (!expected) return

    unmount()
    renderApp('/')
    expect(
      within(screen.getByRole('navigation', { name: '主导航' }))
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(expected.map((path) => NAV_ITEMS.find((item) => item.to === path)?.label))
  })

  it('拖到仪表盘上松手不会把它挤下去', () => {
    renderApp('/')
    const nav = screen.getByRole('navigation', { name: '主导航' })
    const restore = installNavRects()
    try {
      fireEvent.pointerDown(within(nav).getByRole('button', { name: '拖拽排序：安全' }), {
        button: 0,
        pointerId: 1,
        clientY: 64,
      })
      fireEvent.pointerMove(window, { pointerId: 1, clientY: 10 })
      expect(nav.querySelector<HTMLElement>('[data-nav-item="/"]')?.style.transform).toBe('')
      fireEvent.pointerUp(window, { pointerId: 1, clientY: 10 })
    } finally {
      restore()
    }

    const labels = within(nav).getAllByRole('link').map((link) => link.textContent)
    expect(labels[0]).toBe('仪表盘')
    expect(labels[1]).toBe('安全')
  })

  it('方向键可以调整导航顺序，焦点留在同一项上', async () => {
    const user = userEvent.setup()
    renderApp('/')
    const nav = screen.getByRole('navigation', { name: '主导航' })
    const handle = within(nav).getByRole('button', { name: '拖拽排序：安全' })
    handle.focus()
    await user.keyboard('{ArrowUp}')
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)?.[0]).toBe('仪表盘')
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)?.[1]).toBe('安全')

    await user.keyboard('{ArrowDown}')

    expect(document.activeElement).toHaveAccessibleName('拖拽排序：安全')
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)?.[2]).toBe('安全')
  })

  it('已存的导航顺序在侧边栏里生效，收起后不再显示拖拽手柄', async () => {
    const user = userEvent.setup()
    writeStoredNavOrder(
      localStorage,
      ['/websites', '/', '/security', '/docker', '/databases', '/files', '/logs', '/terminals'],
      '2026-09-22T00:00:00.000Z',
    )
    renderApp('/')
    const nav = screen.getByRole('navigation', { name: '主导航' })
    const labels = within(nav).getAllByRole('link')
    expect(labels[0]).toHaveTextContent('仪表盘')
    expect(labels[1]).toHaveTextContent('网站')

    await user.click(screen.getByRole('button', { name: '收起侧边栏' }))
    expect(screen.queryByRole('button', { name: /拖拽排序：/ })).not.toBeInTheDocument()
  })

  it('抽屉里的拖拽与侧边栏共用同一份顺序', async () => {
    const user = userEvent.setup()
    renderApp('/')
    await user.click(screen.getByRole('button', { name: '打开主导航' }))
    const drawer = screen.getByRole('dialog', { name: '主导航' })
    const restore = installNavRects()
    try {
      fireEvent.pointerDown(within(drawer).getByRole('button', { name: '拖拽排序：安全' }), {
        button: 0,
        pointerId: 1,
        clientY: 64,
      })
      fireEvent.pointerMove(window, { pointerId: 1, clientY: 120 })
      fireEvent.pointerUp(window, { pointerId: 1, clientY: 120 })
    } finally {
      restore()
    }

    await user.click(screen.getByRole('button', { name: '关闭主导航' }))
    const labels = within(screen.getByRole('navigation', { name: '主导航' }))
      .getAllByRole('link')
      .map((link) => link.textContent)
    expect(labels[0]).toBe('仪表盘')
    expect(labels[1]).toBe('Docker')
    expect(labels[2]).toBe('安全')
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

describe('侧边栏登出', () => {
  beforeEach(() => {
    useSessionStore.setState({ phase: 'authed', mode: 'real', devAccount: false })
  })

  it('真实会话模式在运维人员行渲染登出按钮，顶栏不再有，点击后回到登录页', async () => {
    const user = userEvent.setup()
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    // 底座装配会同步落位演示放行；注入的 fake session 是事实源，重置后交 probe。
    useSessionStore.setState({ phase: 'unknown', mode: undefined, devAccount: false })
    const { router } = renderApp('/', {
      gateway: {
        ...base,
        session: {
          canView: async () => true,
          status: async () => ({ mode: 'real', authenticated: true, devAccount: false }),
          login: async () => {},
          logout: async () => {},
          listSessions: async () => [
            { createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: '2026-01-01T00:00:00.000Z', current: true },
            { createdAt: '2025-12-30T00:00:00.000Z', lastUsedAt: '2025-12-31T00:00:00.000Z', current: false },
          ],
          changePassword: async () => {
            throw new Error('演示模式不支持修改面板密码')
          },
          logoutOtherSessions: async () => {},
        },
      },
    })

    const logout = await screen.findByRole('button', { name: '退出登录' })
    expect(screen.getByLabelText('快捷操作')).toContainElement(logout)
    expect(screen.getByRole('banner')).not.toContainElement(logout)
    await user.click(logout)

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(await screen.findByRole('heading', { level: 1, name: '登录 Elysian' })).toBeInTheDocument()
  })

  it('演示模式（本地无后端）不渲染登出按钮', async () => {
    renderApp('/')
    await screen.findByRole('banner')
    expect(screen.getByText('运维人员')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '退出登录' })).not.toBeInTheDocument()
  })
})

/** jsdom 没有布局，拖拽槽位按固定行高模拟：每项 40px，间距并进 44px 的步长。 */
function installNavRects() {
  const original = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () {
    const index = this.getAttribute('data-nav-index')
    if (index === null) return original.call(this)
    const top = Number(index) * 44
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 231,
      bottom: top + 40,
      width: 231,
      height: 40,
      toJSON() {
        return {}
      },
    } as DOMRect
  }
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original
  }
}
