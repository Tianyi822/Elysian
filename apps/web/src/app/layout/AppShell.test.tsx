import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../../test/renderApp'
import { NAV_ITEMS } from '../navigation'

describe('应用外壳', () => {
  it('侧边栏按配置呈现全部导航项', () => {
    renderApp('/')
    const nav = screen.getByRole('navigation', { name: '主导航' })
    const labels = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent)
    expect(labels).toEqual(NAV_ITEMS.map((item) => item.label))
  })

  it('当前路由在侧边栏里被标记为当前页', () => {
    renderApp('/approvals')
    expect(screen.getByRole('link', { name: '审批队列' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('每个页面都常驻演示数据标识', () => {
    renderApp('/')
    expect(screen.getByText('演示数据·未连接真实基础设施')).toBeInTheDocument()
  })

  it('主题切换在深色与浅色之间切换 html 标记', async () => {
    const user = userEvent.setup()
    renderApp('/')

    expect(document.documentElement.dataset['theme']).toBe('dark')

    await user.click(screen.getByRole('button', { name: '切换到浅色主题' }))
    expect(document.documentElement.dataset['theme']).toBe('light')

    await user.click(screen.getByRole('button', { name: '切换到深色主题' }))
    expect(document.documentElement.dataset['theme']).toBe('dark')
  })

  it('窄屏抽屉可以打开导航并关闭', async () => {
    const user = userEvent.setup()
    renderApp('/')

    await user.click(screen.getByRole('button', { name: '打开主导航' }))
    const drawer = screen.getByRole('dialog', { name: '主导航' })
    expect(within(drawer).getAllByRole('link')).toHaveLength(NAV_ITEMS.length)

    await user.click(screen.getByRole('button', { name: '关闭主导航' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
