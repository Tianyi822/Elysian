import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderApp } from '../../test/renderApp'
import { resolveViewTab, readStoredViewTab, writeStoredViewTab } from '../../app/theme/themePreferences'
import { useSecurityStore } from '../../stores/securityStore'

/**
 * 只测安全域自己的部分：页签表、选中态与 store 联动、HeaderTabs 的呈现样式。
 * 摊开/收起的宽度自适应与自绘下拉机制与数据库类型切换同构，
 * 在 DatabaseEngineSwitch.test 一处覆盖，不在这里重复。
 */

/** 顶栏的平铺页签条。 */
function segmentGroup(): HTMLElement {
  return within(screen.getByRole('main')).getByRole('group', { name: '安全页签' })
}

beforeEach(() => {
  useSecurityStore.setState({ tab: 'firewall' })
})

describe('安全页签切换', () => {
  it('平铺三个页签，默认选中系统防火墙', () => {
    renderApp('/security')

    const items = within(segmentGroup()).getAllByRole('button')
    expect(items.map((item) => item.textContent)).toEqual(['系统防火墙', 'SSH 管理', '用户管理'])
    expect(items[0]).toHaveAttribute('aria-pressed', 'true')
  })

  it('页签组带统一容器边框，按钮不带分割线，选中态由亮色指示条表达', () => {
    renderApp('/security')

    const group = segmentGroup()
    expect(group).toHaveClass('border', 'border-line')
    const items = within(group).getAllByRole('button')
    for (const item of items) {
      expect(item).not.toHaveClass('border-l')
      expect(item).not.toHaveClass('border')
    }
    // 指示条常驻 DOM，位置在真实浏览器里量出，jsdom 中只验证存在与样式挂载点。
    const indicator = group.querySelector('span[aria-hidden]')
    expect(indicator).toHaveClass('bg-accent')
  })

  it('点击平铺项切换当前页签，选中态随点击移动并同步 store', async () => {
    const user = userEvent.setup()
    renderApp('/security')

    await user.click(within(segmentGroup()).getByRole('button', { name: 'SSH 管理' }))

    expect(within(segmentGroup()).getByRole('button', { name: 'SSH 管理' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(
      within(segmentGroup()).getByRole('button', { name: '系统防火墙' }),
    ).toHaveAttribute('aria-pressed', 'false')
    expect(useSecurityStore.getState().tab).toBe('ssh')
    expect(readStoredViewTab(window.localStorage, 'security')).toBe('ssh')
  })

  it('切到用户管理页签：内容区换成该页签的面板，不再显示防火墙', async () => {
    const user = userEvent.setup()
    renderApp('/security')

    await user.click(within(segmentGroup()).getByRole('button', { name: '用户管理' }))

    expect(useSecurityStore.getState().tab).toBe('users')
    expect(await screen.findByRole('region', { name: '主机账号表' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '端口规则表' })).not.toBeInTheDocument()
  })

  it('刷新后仍选中上次的页签', () => {
    writeStoredViewTab(window.localStorage, 'security', 'ssh')
    useSecurityStore.setState({
      tab: resolveViewTab(window.localStorage, 'security', ['firewall', 'ssh', 'users'] as const, 'firewall'),
    })

    renderApp('/security')

    expect(within(segmentGroup()).getByRole('button', { name: 'SSH 管理' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(segmentGroup()).getByRole('button', { name: '系统防火墙' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
})
