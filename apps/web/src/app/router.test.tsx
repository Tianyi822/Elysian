import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../test/renderApp'

const ROUTES: ReadonlyArray<{ path: string; heading: string }> = [
  { path: '/', heading: '总览' },
  { path: '/incidents', heading: '事件中心' },
  // 事故详情用数据集里真实存在的标识，这样断言的是页面本身而不是外壳。
  { path: '/incidents/INC-2100', heading: '事故详情' },
  { path: '/runs', heading: 'Agent 运行' },
  { path: '/skills', heading: '技能目录' },
  { path: '/approvals', heading: '审批队列' },
  { path: '/audit', heading: '审计日志' },
  { path: '/settings', heading: '系统设置' },
]

describe('路由表', () => {
  // 页面外面还包着访问闸门，首帧不渲染页头，因此断言必须等待。
  it.each(ROUTES)('$path 渲染「$heading」', async ({ path, heading }) => {
    renderApp(path)
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
  })

  it('未匹配的地址进入未找到页面', async () => {
    renderApp('/does-not-exist')
    expect(
      await screen.findByRole('heading', { level: 1, name: '未找到页面' }),
    ).toBeInTheDocument()
  })
})
