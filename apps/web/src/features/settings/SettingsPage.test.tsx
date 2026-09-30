import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { formatDateTime } from '../../components/format'
import { UI_PREFERENCES_KEY } from '../../app/theme/themePreferences'
import type { ElysianGateway, SessionAdapter, SessionListRow } from '../../contracts/adapters'
import { useSessionStore } from '../../stores/sessionStore'
import { renderApp } from '../../test/renderApp'

/*
 * 设置页：活跃会话区块的加载/错误/就绪三态与重试、当前会话标记、演示数据标识；
 * 修改密码的失败反馈与成功流转（页面自身不导航，store 置一次性提示并落 anonymous，
 * 由 RequireSession 唯一导航到 /login）；主题三选一写既有界面偏好；退出其他会话的
 * 确认流转；面板信息只读事实。store 是模块级单例，每条用例前重置。
 */

const PASSWORD_CHANGE_NOTICE = '密码已修改，请使用新密码重新登录'

const CURRENT_ROW: SessionListRow = {
  createdAt: '2026-09-30T02:00:00.000Z',
  lastUsedAt: '2026-09-30T04:00:00.000Z',
  current: true,
}

const OTHER_ROW: SessionListRow = {
  createdAt: '2026-09-27T04:00:00.000Z',
  lastUsedAt: '2026-09-30T03:00:00.000Z',
  current: false,
}

/** 真实模式的会话桩：默认成功返回两行（当前 + 其他），按路径覆写单项。 */
function realSession(overrides: Partial<SessionAdapter> = {}): SessionAdapter {
  return {
    canView: async () => true,
    status: async () => ({ mode: 'real', authenticated: true, devAccount: false }),
    login: async () => {},
    logout: async () => {},
    listSessions: async () => [CURRENT_ROW, OTHER_ROW],
    changePassword: async () => {},
    logoutOtherSessions: async () => {},
    ...overrides,
  }
}

function baseGateway(session: SessionAdapter): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  useSessionStore.setState({ phase: 'unknown', mode: undefined, devAccount: false, notice: null })
  return { ...base, session }
}

beforeEach(() => {
  useSessionStore.setState({ phase: 'unknown', mode: undefined, devAccount: false, notice: null })
})

afterEach(() => {
  delete document.documentElement.dataset['theme']
  localStorage.clear()
  vi.unstubAllGlobals()
})

async function fillPasswordForm(user: ReturnType<typeof userEvent.setup>, current: string, next: string) {
  await user.type(await screen.findByLabelText('当前密码'), current)
  await user.type(screen.getByLabelText('新密码'), next)
  await user.type(screen.getByLabelText('确认新密码'), next)
}

describe('活跃会话区块', () => {
  it('首载显示加载态，就绪后渲染时间列与当前会话标记', async () => {
    let resolveList: (rows: readonly SessionListRow[]) => void = () => {}
    const gateway = baseGateway(
      realSession({
        listSessions: () =>
          new Promise((resolve) => {
            resolveList = resolve
          }),
      }),
    )
    renderApp('/settings', { gateway })

    expect(await screen.findByText('正在加载活跃会话…')).toBeInTheDocument()

    resolveList([CURRENT_ROW, OTHER_ROW])
    const table = await screen.findByRole('region', { name: '活跃会话表' })
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(within(table).getByText(formatDateTime(CURRENT_ROW.createdAt))).toBeInTheDocument()
    expect(within(table).getByText(formatDateTime(CURRENT_ROW.lastUsedAt))).toBeInTheDocument()
    expect(within(table).getByText(formatDateTime(OTHER_ROW.lastUsedAt))).toBeInTheDocument()
    expect(within(table).getByText('当前会话')).toBeInTheDocument()
  })

  it('加载失败显示错误态，「重试」重新拉取并落表', async () => {
    const listSessions = vi
      .fn<() => Promise<readonly SessionListRow[]>>()
      .mockRejectedValueOnce(new Error('会话列表获取失败：面板服务不可达'))
      .mockResolvedValueOnce([CURRENT_ROW])
    const gateway = baseGateway(realSession({ listSessions }))
    const user = userEvent.setup()
    renderApp('/settings', { gateway })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('会话列表获取失败：面板服务不可达')

    await user.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('region', { name: '活跃会话表' })).toBeInTheDocument()
    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  it('演示模式（默认 mock 网关）带「演示数据」标识，列表来自内存种子', async () => {
    renderApp('/settings')
    expect(await screen.findByText('演示数据')).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: '活跃会话表' })).toBeInTheDocument()
  })

  it('真实模式不显示「演示数据」标识', async () => {
    renderApp('/settings', { gateway: baseGateway(realSession()) })
    await screen.findByRole('region', { name: '活跃会话表' })
    expect(screen.queryByText('演示数据')).not.toBeInTheDocument()
  })

  it('列表里没有其他会话时「退出其他会话」禁用', async () => {
    renderApp('/settings', { gateway: baseGateway(realSession({ listSessions: async () => [CURRENT_ROW] })) })
    await screen.findByRole('region', { name: '活跃会话表' })
    expect(screen.getByRole('button', { name: '退出其他会话' })).toBeDisabled()
  })

  it('退出其他会话：确认框出现，取消无变更，确认后列表只剩当前会话行', async () => {
    renderApp('/settings')
    const user = userEvent.setup()
    const table = await screen.findByRole('region', { name: '活跃会话表' })
    expect(within(table).getAllByRole('row')).toHaveLength(3)

    await user.click(screen.getByRole('button', { name: '退出其他会话' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('将退出其他浏览器或窗口里的全部会话，当前会话不受影响。')

    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(within(screen.getByRole('region', { name: '活跃会话表' })).getAllByRole('row')).toHaveLength(3)

    await user.click(screen.getByRole('button', { name: '退出其他会话' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认退出' }))
    await waitFor(() =>
      expect(within(screen.getByRole('region', { name: '活跃会话表' })).getAllByRole('row')).toHaveLength(2),
    )
    expect(within(screen.getByRole('region', { name: '活跃会话表' })).getAllByText('当前会话')).toHaveLength(1)
  })
})

describe('修改面板密码', () => {
  it('提交失败把中文错误显示在 role="alert"', async () => {
    const gateway = baseGateway(
      realSession({
        changePassword: async () => {
          throw new Error('当前密码不正确')
        },
      }),
    )
    const user = userEvent.setup()
    renderApp('/settings', { gateway })

    await fillPasswordForm(user, 'old-password', 'brand-new-pw')
    await user.click(screen.getByRole('button', { name: '修改密码' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('当前密码不正确')
    // 失败后留在页内，按钮解除禁用可再次提交。
    expect(screen.getByRole('button', { name: '修改密码' })).toBeEnabled()
  })

  it('演示模式校验通过后如实抛「演示模式不支持修改面板密码」', async () => {
    renderApp('/settings')
    const user = userEvent.setup()

    await fillPasswordForm(user, 'old-password', 'brand-new-pw')
    await user.click(screen.getByRole('button', { name: '修改密码' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('演示模式不支持修改面板密码')
  })

  it('演示模式两次不一致先得到一致性错误（与服务端同一次序）', async () => {
    renderApp('/settings')
    const user = userEvent.setup()

    await user.type(await screen.findByLabelText('当前密码'), 'old-password')
    await user.type(screen.getByLabelText('新密码'), 'brand-new-pw')
    await user.type(screen.getByLabelText('确认新密码'), 'mismatch-pw')
    await user.click(screen.getByRole('button', { name: '修改密码' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('两次输入的密码不一致')
  })

  it('成功后页面自身不导航：store 置一次性提示并落 anonymous，RequireSession 把路由带到 /login', async () => {
    const { router } = renderApp('/settings', { gateway: baseGateway(realSession()) })
    const user = userEvent.setup()

    await screen.findByRole('region', { name: '活跃会话表' })
    await fillPasswordForm(user, 'old-password', 'brand-new-pw')
    await user.click(screen.getByRole('button', { name: '修改密码' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    // 导航 state 来自 RequireSession 的 { from }，不是页面自带的 { notice }：唯一导航者是闸门。
    expect(router.state.location.state).toMatchObject({ from: '/settings' })
    expect(useSessionStore.getState()).toMatchObject({
      phase: 'anonymous',
      notice: PASSWORD_CHANGE_NOTICE,
    })
    expect(screen.getByRole('heading', { level: 1, name: '登录 Elysian' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(PASSWORD_CHANGE_NOTICE)
  })
})

describe('外观', () => {
  it('主题三选一：选中即生效并写进既有界面偏好', async () => {
    renderApp('/settings')
    const user = userEvent.setup()
    const group = await screen.findByRole('radiogroup', { name: '主题' })
    expect(within(group).getByRole('radio', { name: '跟随系统' })).toBeChecked()

    await user.click(within(group).getByRole('radio', { name: '深色' }))

    expect(document.documentElement.dataset['theme']).toBe('dark')
    expect(JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY) ?? '{}')).toMatchObject({
      version: 1,
      theme: 'dark',
    })
    expect(within(group).getByRole('radio', { name: '深色' })).toBeChecked()

    await user.click(within(group).getByRole('radio', { name: '浅色' }))

    expect(document.documentElement.dataset['theme']).toBe('light')
    expect(within(group).getByRole('radio', { name: '浅色' })).toBeChecked()
  })

  it('「跟随系统」清掉主题偏好，页签等其他偏好保留', async () => {
    localStorage.setItem(
      UI_PREFERENCES_KEY,
      JSON.stringify({ version: 1, theme: 'dark', savedAt: 'x', tabs: { security: 'ssh' } }),
    )
    // 与 ThemeProvider.test 同款：显式桩定系统档（matches:false → 深色），不依赖宿主环境，
    // 也避开其他用例的 stubGlobal 恢复把 window.matchMedia 留成 undefined 的脏状态。
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }))
    renderApp('/settings')
    const user = userEvent.setup()
    const group = await screen.findByRole('radiogroup', { name: '主题' })
    expect(within(group).getByRole('radio', { name: '深色' })).toBeChecked()

    await user.click(within(group).getByRole('radio', { name: '跟随系统' }))

    const stored = JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY) ?? '{}')
    expect(stored.theme).toBeUndefined()
    expect(stored.tabs).toMatchObject({ security: 'ssh' })
    expect(within(group).getByRole('radio', { name: '跟随系统' })).toBeChecked()
  })
})

describe('面板信息', () => {
  it('渲染账号、端口与数据目录三项只读事实', async () => {
    renderApp('/settings')
    const section = await screen.findByRole('region', { name: '面板信息' })
    expect(within(section).getByText('admin')).toBeInTheDocument()
    expect(within(section).getByText('48100')).toBeInTheDocument()
    expect(within(section).getByText('~/.Elysian')).toBeInTheDocument()
    expect(within(section).getByText(/仅宿主回环可达/)).toBeInTheDocument()
    expect(within(section).getByText(/指向持久卷 \/var\/lib\/elysian 的符号链接/)).toBeInTheDocument()
  })
})
