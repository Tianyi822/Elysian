import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../test/renderApp'

describe('路由表', () => {
  it('/ 渲染仪表盘', async () => {
    renderApp('/')
    expect(await screen.findByRole('heading', { level: 1, name: '仪表盘' })).toBeInTheDocument()
  })

  it('/containers 渲染 Docker 区', async () => {
    renderApp('/containers')
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

  it('/logs 渲染日志区，顶栏出现日志页签', async () => {
    renderApp('/logs')
    const group = await screen.findByRole('group', { name: '日志页签' })
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '运行日志',
      '登录日志',
    ])
  })

  it('未匹配的地址进入未找到页面', async () => {
    renderApp('/does-not-exist')
    expect(
      await screen.findByRole('heading', { level: 1, name: '未找到页面' }),
    ).toBeInTheDocument()
  })
})
