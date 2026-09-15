import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../test/renderApp'

describe('路由表', () => {
  it('/ 渲染仪表盘', async () => {
    renderApp('/')
    expect(await screen.findByRole('heading', { level: 1, name: '仪表盘' })).toBeInTheDocument()
  })

  it('/containers 渲染 Docker 区', async () => {
    renderApp('/containers')
    expect(await screen.findByRole('heading', { level: 1, name: 'Docker' })).toBeInTheDocument()
  })

  it('未匹配的地址进入未找到页面', async () => {
    renderApp('/does-not-exist')
    expect(
      await screen.findByRole('heading', { level: 1, name: '未找到页面' }),
    ).toBeInTheDocument()
  })
})
