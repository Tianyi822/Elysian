import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderApp } from '../test/renderApp'
import { resetAgentTestState } from '../test/agentTestUtils'
import { useTerminalsStore } from '../stores/terminalsStore'

beforeEach(() => {
  useTerminalsStore.getState().resetLocal()
  resetAgentTestState()
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

  it('/agent 渲染 Ely 工作台与七页签', async () => {
    renderApp('/agent')
    const group = await screen.findByRole('group', { name: 'Ely 页签' })
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '工作台',
      '审批与治理',
      '运行记录',
      '工作流',
      '执行配置',
      '技能与 MCP',
      '长期记忆',
    ])
    expect(await screen.findByRole('navigation', { name: '工作台视图' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ely' })).toHaveAttribute('aria-current', 'page')
  })

  it.each([
    ['/agent/runs', 'region', 'Run 列表'],
    ['/agent/workflows', 'region', '工作流'],
    ['/agent/capabilities', 'group', '配置页签'],
  ] as const)('%s 可达且渲染功能页', async (path, role, name) => {
    renderApp(path)
    expect(await screen.findByRole(role, { name })).toBeInTheDocument()
    // 顶栏页签不重复渲染（收起形态隐藏，摊开形态只有一份）。
    expect(screen.getAllByRole('group', { name: 'Ely 页签' })).toHaveLength(1)
  })

  it('/agent/approvals 可达且渲染审批与治理页（agent-approvals 模块已落地）', async () => {
    renderApp('/agent/approvals')
    expect(await screen.findByRole('group', { name: '审批与治理页签' })).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: '审批列表' })).toBeInTheDocument()
    expect(screen.getAllByRole('group', { name: 'Ely 页签' })).toHaveLength(1)
  })

  it('/agent/extensions 可达且渲染技能与 MCP 页（agent-extensions 模块已落地）', async () => {
    renderApp('/agent/extensions')
    expect(await screen.findByRole('region', { name: '技能目录' })).toBeInTheDocument()
    expect(screen.getAllByRole('group', { name: 'Ely 页签' })).toHaveLength(1)
  })

  it('/agent/memory 可达且渲染长期记忆页（agent-memory 模块已落地）', async () => {
    renderApp('/agent/memory')
    expect(await screen.findByRole('region', { name: '记忆空间列表' })).toBeInTheDocument()
    expect(await screen.findByText('全局运维常识')).toBeInTheDocument()
    expect(screen.getAllByRole('group', { name: 'Ely 页签' })).toHaveLength(1)
  })

  it('未匹配的地址进入未找到页面', async () => {
    renderApp('/does-not-exist')
    expect(
      await screen.findByRole('heading', { level: 1, name: '未找到页面' }),
    ).toBeInTheDocument()
  })
})
