import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../test/renderApp'

const ROUTES: ReadonlyArray<{ path: string; heading: string }> = [
  { path: '/', heading: '总览' },
  { path: '/incidents', heading: '事件中心' },
  { path: '/incidents/INC-2041', heading: '事故详情' },
  { path: '/runs', heading: 'Agent 运行' },
  { path: '/skills', heading: '技能目录' },
  { path: '/approvals', heading: '审批队列' },
  { path: '/audit', heading: '审计日志' },
  { path: '/settings', heading: '系统设置' },
]

describe('路由表', () => {
  it.each(ROUTES)('$path 渲染「$heading」', ({ path, heading }) => {
    renderApp(path)
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
  })

  it('未匹配的地址进入未找到页面', () => {
    renderApp('/does-not-exist')
    expect(screen.getByRole('heading', { level: 1, name: '未找到页面' })).toBeInTheDocument()
  })
})
