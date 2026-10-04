import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway, SessionAdapter } from '../../contracts/adapters'
import { useSessionStore } from '../../stores/sessionStore'
import { renderApp } from '../../test/renderApp'

/*
 * 设置页只保留修改密码：失败反馈、演示模式的如实失败、两次不一致的校验次序、
 * 成功后由 RequireSession 唯一导航到 /login。字段下的规则随输入更新。
 * store 是模块级单例，每条用例前重置。
 */

const PASSWORD_CHANGE_NOTICE = '密码已修改，请使用新密码重新登录'

function realSession(overrides: Partial<SessionAdapter> = {}): SessionAdapter {
  return {
    canView: async () => true,
    status: async () => ({ mode: 'real', authenticated: true, devAccount: false }),
    login: async () => {},
    logout: async () => {},
    listSessions: async () => [],
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

async function fillPasswordForm(user: ReturnType<typeof userEvent.setup>, current: string, next: string) {
  await user.type(await screen.findByLabelText('当前密码'), current)
  await user.type(screen.getByLabelText('新密码'), next)
  await user.type(screen.getByLabelText('确认新密码'), next)
}

describe('修改面板密码', () => {
  it('校验后确认，取消保留输入且不提交', async () => {
    const changePassword = vi.fn(async () => {})
    renderApp('/settings', { gateway: baseGateway(realSession({ changePassword })) })
    const user = userEvent.setup()
    await fillPasswordForm(user, 'old-password', 'brand-new-pw')
    await user.click(screen.getByRole('button', { name: '修改密码' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('修改后，所有已登录设备都会退出，请用新密码重新登录。')
    expect(changePassword).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByLabelText('新密码')).toHaveValue('brand-new-pw')
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('每个密码框都能单独显示和隐藏', async () => {
    renderApp('/settings')
    const user = userEvent.setup()
    const current = await screen.findByLabelText('当前密码')
    const next = screen.getByLabelText('新密码')
    const toggle = within(current.parentElement as HTMLElement).getByRole('button', { name: '显示密码' })

    expect(current).toHaveAttribute('type', 'password')
    expect(next).toHaveAttribute('type', 'password')

    await user.click(toggle)
    expect(current).toHaveAttribute('type', 'text')
    expect(next).toHaveAttribute('type', 'password')
    expect(within(current.parentElement as HTMLElement).getByRole('button', { name: '隐藏密码' })).toBeInTheDocument()
  })

  it('规则贴在字段下方，并随输入从「至少 8 位」变成还差几位、再变成已满足', async () => {
    renderApp('/settings')
    const user = userEvent.setup()

    expect(await screen.findByText('至少 8 位')).toBeInTheDocument()
    expect(screen.getByText('再输入一次新密码')).toBeInTheDocument()
    expect(screen.queryByText('修改后，所有已登录设备都会退出，请用新密码重新登录。')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('新密码'), 'short')
    expect(screen.getByText('还差 3 位')).toBeInTheDocument()
    expect(screen.getByLabelText('新密码')).toHaveAttribute('aria-invalid', 'true')

    await user.type(screen.getByLabelText('新密码'), '123')
    expect(screen.getByText('已满 8 位')).toBeInTheDocument()
    expect(screen.getByLabelText('新密码')).not.toHaveAttribute('aria-invalid')

    await user.type(screen.getByLabelText('确认新密码'), 'short')
    expect(screen.getByText('与新密码不一致')).toBeInTheDocument()

    await user.type(screen.getByLabelText('确认新密码'), '123')
    expect(screen.getByText('与新密码一致')).toBeInTheDocument()
  })

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
    await user.click(screen.getByRole('button', { name: '确认修改' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('当前密码不正确')
    expect(screen.getByRole('button', { name: '修改密码' })).toBeEnabled()
  })

  it('演示模式校验通过后如实抛「演示模式不支持修改面板密码」', async () => {
    renderApp('/settings')
    const user = userEvent.setup()

    await fillPasswordForm(user, 'old-password', 'brand-new-pw')
    await user.click(screen.getByRole('button', { name: '修改密码' }))
    await user.click(screen.getByRole('button', { name: '确认修改' }))

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

    await fillPasswordForm(user, 'old-password', 'brand-new-pw')
    await user.click(screen.getByRole('button', { name: '修改密码' }))
    await user.click(screen.getByRole('button', { name: '确认修改' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(router.state.location.state).toMatchObject({ from: '/settings' })
    expect(useSessionStore.getState()).toMatchObject({
      phase: 'anonymous',
      notice: PASSWORD_CHANGE_NOTICE,
    })
    expect(screen.getByRole('heading', { level: 1, name: '登录 Elysian' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(PASSWORD_CHANGE_NOTICE)
  })
})
