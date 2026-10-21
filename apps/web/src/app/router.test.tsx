import { screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../test/renderApp'
import { useTerminalsStore } from '../stores/terminalsStore'
import { createMockGateway } from '../adapters/mock/gateway'

const agentRoutes = [
  ['/agent/extensions', '技能与 MCP'],
] as const

beforeEach(() => {
  useTerminalsStore.getState().resetLocal()
})

describe('路由表', () => {
  it('/ 渲染仪表盘', async () => {
    renderApp('/')
    expect(await screen.findByRole('heading', { level: 1, name: '仪表盘' })).toBeInTheDocument()
  })

  it('/containers 渲染 Docker 区', async () => {
    renderApp('/docker')
    expect(await screen.findByRole('group', { name: '视图切换' })).toBeInTheDocument()
  })

  it('/databases 渲染数据库区', async () => {
    renderApp('/databases')
    expect(await screen.findByRole('group', { name: '数据库类型' })).toBeInTheDocument()
  })

  it('/files 渲染文件管理页，当前目录（根）占据标题位', async () => {
    renderApp('/files')
    expect(await screen.findByRole('heading', { level: 1, name: '/' })).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: '文件管理' })).toBeInTheDocument()
  })

  it('/files/var/log 深链直达子目录，路径标题随地址变化', async () => {
    renderApp('/files/var/log')
    expect(await screen.findByRole('heading', { level: 1, name: '/var/log' })).toBeInTheDocument()
  })

  it('/logs 渲染日志区，顶栏出现三类日志的页签', async () => {
    renderApp('/logs')
    const group = await screen.findByRole('group', { name: '日志页签' })
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '运行日志',
      '登录日志',
      '操作日志',
    ])
  })

  it('/terminals 渲染终端区：整条顶栏不渲染，窄屏仍留有打开主导航的入口', async () => {
    renderApp('/terminals')
    expect(await screen.findByRole('link', { name: '终端' })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByRole('tablist', { name: '终端会话' })).toBeInTheDocument()
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开主导航' })).toBeInTheDocument()
  })

  it('/websites 渲染网站区，顶栏不再有页签', async () => {
    renderApp('/websites')
    expect(await screen.findByRole('heading', { level: 1, name: '网站' })).toBeInTheDocument()
    // 类型改在创建时选择，顶栏页签已随五页签表格一起删除；面板内容由面板自己的测试覆盖。
    expect(screen.queryByRole('group', { name: '网站页签' })).not.toBeInTheDocument()
  })

  it('账号安全页签渲染密码表单和设置导航', async () => {
    renderApp('/settings?tab=account')
    expect(await screen.findByRole('heading', { level: 1, name: '设置' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '修改面板密码' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '外观' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '面板信息' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '活跃会话表' })).not.toBeInTheDocument()
  })

  it.each(agentRoutes)('%s 不显示页签，内容区为空且不读取 Agent 数据', async (path) => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    const runtime = vi.spyOn(gateway.agentRuntime, 'runtime')
    const models = vi.spyOn(gateway.modelSettings, 'listModelServices')
    renderApp(`${path}?session=existing-session`, { gateway })
    expect(screen.queryByRole('group', { name: 'Ely 页签' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('正在校验访问权限…')).not.toBeInTheDocument())
    expect(screen.getByRole('main').children).toHaveLength(2)
    expect(runtime).not.toHaveBeenCalled()
    expect(models).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'Ely 智能体' })).toHaveAttribute('aria-current', 'page')
  })

  it.each(['/agent/approvals', '/agent/runs', '/agent/workflows'])(
    '%s 已退役并显示未找到页面',
    async (path) => {
      renderApp(path)
      expect(await screen.findByRole('heading', { level: 1, name: '未找到页面' })).toBeInTheDocument()
    },
  )

  it('/agent/capabilities 未指定模型页签时回到聊天', async () => {
    const { router } = renderApp('/agent/capabilities')
    await waitFor(() => expect(router.state.location.pathname).toBe('/agent'))
  })

  it('长期记忆入口渲染知识 Wiki 工作台', async () => {
    renderApp('/agent/memory')
    expect(await screen.findByRole('region', { name: '知识 Wiki 工作台' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导入资料' })).toBeInTheDocument()
  })

  it('知识 Wiki 独立浏览页可达，主导航高亮', async () => {
    renderApp('/wiki')
    expect(await screen.findByRole('region', { name: 'Wiki 页面浏览' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '知识 Wiki' })).toHaveAttribute('aria-current', 'page')
  })

  it('智能体入口打开本地会话，仅加载模型目录且不检查运行时', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const runtime = vi.spyOn(gateway.agentRuntime, 'runtime')
    const models = vi.spyOn(gateway.modelSettings, 'listModelServices')
    renderApp('/agent', { gateway })
    expect(await screen.findByRole('textbox', { name: '发送给 Ely 的消息' })).toBeInTheDocument()
    await waitFor(() => expect(models).toHaveBeenCalledTimes(1))
    expect(runtime).not.toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: 'Ely 页签' })).not.toBeInTheDocument()
  })

  it('智能体入口仍执行访问权限检查', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    vi.spyOn(gateway.session, 'canView').mockResolvedValue(false)
    renderApp('/agent', { gateway })
    expect(await screen.findByText('无权限查看「Ely 工作台」')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Ely 页签' })).not.toBeInTheDocument()
  })

  it('未匹配的地址进入未找到页面', async () => {
    renderApp('/does-not-exist')
    expect(
      await screen.findByRole('heading', { level: 1, name: '未找到页面' }),
    ).toBeInTheDocument()
  })
})
