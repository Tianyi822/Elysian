import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway, SessionAdapter } from '../../contracts/adapters'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { useModelSettingsStore } from '../../stores/modelSettingsStore'
import { demoAgentRuntimeInfo } from '../../adapters/mock/agent/agentRuntimeMock'
import { useSessionStore } from '../../stores/sessionStore'
import { useMessageStore } from '../../stores/messageStore'
import { useSettingsTabStore } from '../../stores/settingsTabStore'
import { renderApp } from '../../test/renderApp'

/*
 * 设置页页签、懒加载与草稿保留，以及账号改密闭环。
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
  useAgentRuntimeStore.getState().reset()
  useModelSettingsStore.getState().reset()
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
    renderApp('/settings?tab=account', { gateway: baseGateway(realSession({ changePassword })) })
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
    renderApp('/settings?tab=account')
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
    renderApp('/settings?tab=account')
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

  it('提交失败把中文错误放入通知区并保留密码草稿', async () => {
    const gateway = baseGateway(
      realSession({
        changePassword: async () => {
          throw new Error('当前密码不正确')
        },
      }),
    )
    const user = userEvent.setup()
    renderApp('/settings?tab=account', { gateway })

    await fillPasswordForm(user, 'old-password', 'brand-new-pw')
    await user.click(screen.getByRole('button', { name: '修改密码' }))
    await user.click(screen.getByRole('button', { name: '确认修改' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('当前密码不正确')
    expect(useMessageStore.getState().messages).toContainEqual(expect.objectContaining({ tone: 'danger', message: '当前密码不正确' }))
    expect(screen.getByLabelText('新密码')).toHaveValue('brand-new-pw')
    expect(screen.getByRole('button', { name: '修改密码' })).toBeEnabled()
  })

  it('演示模式校验通过后如实抛「演示模式不支持修改面板密码」', async () => {
    renderApp('/settings?tab=account')
    const user = userEvent.setup()

    await fillPasswordForm(user, 'old-password', 'brand-new-pw')
    await user.click(screen.getByRole('button', { name: '修改密码' }))
    await user.click(screen.getByRole('button', { name: '确认修改' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('演示模式不支持修改面板密码')
  })

  it('演示模式两次不一致先得到一致性错误（与服务端同一次序）', async () => {
    renderApp('/settings?tab=account')
    const user = userEvent.setup()

    await user.type(await screen.findByLabelText('当前密码'), 'old-password')
    await user.type(screen.getByLabelText('新密码'), 'brand-new-pw')
    await user.type(screen.getByLabelText('确认新密码'), 'mismatch-pw')
    await user.click(screen.getByRole('button', { name: '修改密码' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('两次输入的密码不一致')
  })

  it('成功后页面自身不导航：store 置一次性提示并落 anonymous，RequireSession 把路由带到 /login', async () => {
    const { router } = renderApp('/settings?tab=account', { gateway: baseGateway(realSession()) })
    const user = userEvent.setup()

    await fillPasswordForm(user, 'old-password', 'brand-new-pw')
    await user.click(screen.getByRole('button', { name: '修改密码' }))
    await user.click(screen.getByRole('button', { name: '确认修改' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    // ?tab= 深链在落地时已从地址摘除，回跳记录的是干净地址；页签由会话记忆负责恢复。
    expect(router.state.location.state).toMatchObject({ from: '/settings' })
    expect(useSessionStore.getState()).toMatchObject({
      phase: 'anonymous',
      notice: PASSWORD_CHANGE_NOTICE,
    })
    expect(screen.getByRole('heading', { level: 1, name: '登录 Elysian' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(PASSWORD_CHANGE_NOTICE)
  })
})

describe('设置页签与模型入口', () => {
  it('首次访问账号页不读取模型，切换后保留模型弹窗草稿并隐藏其门户', async () => {
    const gateway = baseGateway(realSession())
    const read = vi.spyOn(gateway.modelSettings, 'listModelServices')
    const { router } = renderApp('/settings?tab=account', { gateway })
    const user = userEvent.setup()
    await screen.findByLabelText('当前密码')
    expect(read).not.toHaveBeenCalled()
    await user.click(within(screen.getByRole('group', { name: '设置页签' })).getByRole('button', { name: '模型配置' }))
    await screen.findByRole('region', { name: '模型配置列表' })
    await user.click(screen.getByRole('button', { name: '新建模型配置' }))
    await user.clear(screen.getByLabelText('名称'))
    await user.type(screen.getByLabelText('名称'), '尚未保存的模型草稿')
    await act(async () => { await router.navigate('/settings?tab=account') })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => { await router.navigate('/settings?tab=models') })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('名称')).toHaveValue('尚未保存的模型草稿')
    expect(screen.getByLabelText('提供商')).toHaveTextContent('自定义（兼容 API）')
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('默认进入第一个页签（面板维护），页面未关闭时往返记住上次页签，重新打开面板回到第一个', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/settings?source=workbench')
    expect(await screen.findByLabelText('前端端口')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '模型配置列表' })).not.toBeInTheDocument()

    const tabs = screen.getByRole('group', { name: '设置页签' })
    await user.click(within(tabs).getByRole('button', { name: '账号安全' }))
    await user.type(await screen.findByLabelText('当前密码'), 'unsaved-draft')
    // 切页签不动其他查询参数。
    await user.click(within(tabs).getByRole('button', { name: '面板维护' }))
    expect(router.state.location.search).toContain('source=workbench')

    // 以账号安全作为「上次的页签」离开设置页，会话记忆应在回来时恢复它。
    await user.click(within(tabs).getByRole('button', { name: '账号安全' }))
    await act(async () => { await router.navigate('/') })
    await act(async () => { await router.navigate('/settings') })
    expect(await screen.findByLabelText('当前密码')).toBeInTheDocument()
    expect(
      within(screen.getByRole('group', { name: '设置页签' })).getByRole('button', { name: '账号安全' }),
    ).toHaveAttribute('aria-pressed', 'true')

    // 关闭页面后重新打开等于新的页面会话：页签回到第一个。
    // 已访问过的页签仍保持挂载（保草稿），但选中态回到面板维护。
    act(() => { useSettingsTabStore.setState({ tab: 'maintenance' }) })
    expect(await screen.findByLabelText('前端端口')).toBeInTheDocument()
    const reopened = screen.getByRole('group', { name: '设置页签' })
    expect(within(reopened).getByRole('button', { name: '面板维护' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(reopened).getByRole('button', { name: '账号安全' })).toHaveAttribute('aria-pressed', 'false')
  })
  it('维护回跳直接显示面板维护', async () => {
    renderApp('/settings?maintenanceTask=test-task')
    expect(await screen.findByLabelText('前端端口')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '模型配置列表' })).not.toBeInTheDocument()
  })
  it('旧入口在内核不可用时也迁移，账号安全继续可访问', async () => {
    const gateway = baseGateway(realSession())
    gateway.agentRuntime.runtime = async () => ({ ...demoAgentRuntimeInfo(), available: false, reason: '测试内核未就绪' })
    const { router } = renderApp('/agent/capabilities?tab=models', { gateway })
    expect(await screen.findByText('测试内核未就绪')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/settings')
    // ?tab= 是一次性深链：记进会话记忆后即从地址摘除，刷新与再次进入回落记忆。
    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(
      within(screen.getByRole('group', { name: '设置页签' })).getByRole('button', { name: '模型配置' }),
    ).toHaveAttribute('aria-pressed', 'true')
    const user = userEvent.setup()
    await user.click(within(screen.getByRole('group', { name: '设置页签' })).getByRole('button', { name: '账号安全' }))
    expect(await screen.findByLabelText('当前密码')).toBeInTheDocument()
  })
  it('模型设置保留 Agent 权限检查，拒绝后不读取模型目录', async () => {
    const gateway = baseGateway(realSession({ canView: async (area) => area !== 'agent' }))
    const read = vi.spyOn(gateway.modelSettings, 'listModelServices')
    renderApp('/settings?tab=models', { gateway })
    expect(await screen.findByText('无权限查看「模型配置」')).toBeInTheDocument()
    expect(read).not.toHaveBeenCalled()
  })
})
