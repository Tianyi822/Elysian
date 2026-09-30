import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderApp } from '../test/renderApp'
import { useTerminalsStore } from '../stores/terminalsStore'

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

  it('/settings 渲染设置页，顶栏标题随导航项给出，会话区块落演示数据', async () => {
    renderApp('/settings')
    expect(await screen.findByRole('heading', { level: 1, name: '设置' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '账号与安全' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '外观' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '面板信息' })).toBeInTheDocument()
    // 演示网关的会话列表是内存种子两行，当前会话标记可见。
    expect(await screen.findByRole('region', { name: '活跃会话表' })).toBeInTheDocument()
    expect(screen.getByText('当前会话')).toBeInTheDocument()
  })

  it('未匹配的地址进入未找到页面', async () => {
    renderApp('/does-not-exist')
    expect(
      await screen.findByRole('heading', { level: 1, name: '未找到页面' }),
    ).toBeInTheDocument()
  })
})
