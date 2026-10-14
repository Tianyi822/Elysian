import * as Tooltip from '@radix-ui/react-tooltip'
import { act, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { ThemeProvider } from '../theme/ThemeProvider'
import { AppShell } from './AppShell'
import { ShellPageFallback, useShellLayout, type ShellLayout } from './ShellLayoutContext'

let currentLayout: ShellLayout
function Probe() {
  currentLayout = useShellLayout()
  return <ShellPageFallback><div role="status">测试页面状态</div></ShellPageFallback>
}

function renderShell(path = '/') {
  const router = createMemoryRouter([{
    element: <AppShell />,
    children: [
      { path: '/', element: <Probe /> },
      { path: '/agent', handle: { hideHeader: true, flushMain: true }, element: <Probe /> },
      { path: '/agent/approvals', element: <Probe /> },
    ],
  }], { initialEntries: [path] })
  render(<ThemeProvider><Tooltip.Provider><GatewayProvider gateway={createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })}>
    <RouterProvider router={router} />
  </GatewayProvider></Tooltip.Provider></ThemeProvider>)
  return router
}

afterEach(() => { useEventStreamStore.getState().disconnect() })

describe('业务页与外壳布局接缝', () => {
  it('聊天页不折叠主导航，继承进入前收展，聊天内改动离开后还原', async () => {
    const router = renderShell()
    expect(screen.getByRole('complementary', { name: '桌面主导航' })).toHaveClass('w-60')
    await act(() => router.navigate('/agent'))
    expect(currentLayout.isAgentChat).toBe(true)
    expect(screen.getByRole('complementary', { name: '桌面主导航' })).toHaveClass('w-60')
    act(() => currentLayout.setSidebarCollapsed(true))
    expect(currentLayout.sidebarCollapsed).toBe(true)
    await act(() => router.navigate('/agent?session=another'))
    expect(currentLayout.sidebarCollapsed).toBe(true)
    await act(() => router.navigate('/agent/approvals'))
    expect(currentLayout.isAgentChat).toBe(false)
    expect(screen.getByRole('complementary', { name: '桌面主导航' })).toHaveClass('w-60')
    await act(() => router.navigate('/agent'))
    expect(screen.getByRole('complementary', { name: '桌面主导航' })).toHaveClass('w-60')
  })

  it('聊天里的临时收起不覆盖用户进入前展开的主导航', async () => {
    const router = renderShell()
    expect(currentLayout.sidebarCollapsed).toBe(false)
    await act(() => router.navigate('/agent'))
    act(() => currentLayout.setSidebarCollapsed(true))
    await act(() => router.navigate('/'))
    expect(currentLayout.sidebarCollapsed).toBe(false)
    expect(screen.getByRole('complementary', { name: '桌面主导航' })).toHaveClass('w-60')
  })

  it('用户进入前已收起的主导航在聊天页保持收起', async () => {
    const router = renderShell()
    act(() => currentLayout.setSidebarCollapsed(true))
    await act(() => router.navigate('/agent'))
    expect(screen.getByRole('complementary', { name: '桌面主导航' })).toHaveClass('w-16')
    act(() => currentLayout.setSidebarCollapsed(false))
    await act(() => router.navigate('/'))
    expect(currentLayout.sidebarCollapsed).toBe(true)
    expect(screen.getByRole('complementary', { name: '桌面主导航' })).toHaveClass('w-16')
  })

  it('主导航和会话抽屉互斥，旧抽屉关闭事件不会关掉新抽屉', async () => {
    const router = renderShell('/agent')
    act(() => currentLayout.openNavigation())
    expect(screen.getByRole('dialog', { name: '主导航' })).toBeInTheDocument()
    expect(currentLayout.conversationDrawerOpen).toBe(false)
    act(() => currentLayout.openConversationDrawer())
    expect(screen.queryByRole('dialog', { name: '主导航' })).not.toBeInTheDocument()
    expect(currentLayout.navigationOpen).toBe(false)
    expect(currentLayout.conversationDrawerOpen).toBe(true)
    act(() => currentLayout.closeNavigation())
    expect(currentLayout.conversationDrawerOpen).toBe(true)
    act(() => currentLayout.openNavigation())
    expect(currentLayout.navigationOpen).toBe(true)
    expect(currentLayout.conversationDrawerOpen).toBe(false)
    act(() => currentLayout.closeConversationDrawer())
    expect(currentLayout.navigationOpen).toBe(true)
    await act(() => router.navigate('/'))
    expect(currentLayout.navigationOpen).toBe(false)
    expect(currentLayout.conversationDrawerOpen).toBe(false)
  })

  it('全屏页状态补齐页面内距与窄屏导航高度，普通页不重复添加', async () => {
    const router = renderShell('/agent')
    expect(screen.getByText('测试页面状态').parentElement).toHaveClass('p-4', 'md:p-6', 'pt-[calc(var(--shell-header-height)+1rem)]', 'md:pt-6')
    expect(screen.getByRole('main')).not.toHaveClass('p-4')
    await act(() => router.navigate('/'))
    expect(screen.getByText('测试页面状态').parentElement).toBe(screen.getByRole('main'))
    expect(screen.getByRole('main')).toHaveClass('p-4', 'md:p-6')
  })
})
