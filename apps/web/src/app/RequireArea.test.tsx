import { messageHistoryText } from '../test/messageHistory'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { GatewayProvider } from '../adapters/GatewayProvider'
import { createMockGateway } from '../adapters/mock/gateway'
import type { ElysianGateway, PageArea } from '../contracts/adapters'
import { renderApp } from '../test/renderApp'
import { RequireArea } from './RequireArea'

function gatewayDenying(area: PageArea): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  return {
    ...base,
    session: {
      canView: async (requested) => requested !== area,
      status: async () => ({ mode: 'demo', authenticated: true, devAccount: false }),
      login: async () => {},
      logout: async () => {},
      listSessions: async () => [
        { createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: '2026-01-01T00:00:00.000Z', current: true },
        { createdAt: '2025-12-30T00:00:00.000Z', lastUsedAt: '2025-12-31T00:00:00.000Z', current: false },
      ],
      changePassword: async () => {
        throw new Error('演示模式不支持修改面板密码')
      },
      logoutOtherSessions: async () => {},
    },
  }
}

describe('页面级访问闸门', () => {
  it('默认全部放行，仪表盘正常渲染', async () => {
    renderApp('/')
    expect(await screen.findByRole('heading', { level: 1, name: '仪表盘' })).toBeInTheDocument()
    expect(screen.queryByText('无访问权限')).not.toBeInTheDocument()
  })

  it('无权限时给出明确的无权限状态，而不是空白页', async () => {
    renderApp('/', { gateway: gatewayDenying('dashboard') })

    expect(await screen.findByText('无权限查看「仪表盘」', { exact: true })).toBeInTheDocument()
    expect(messageHistoryText()).toContain('无权限查看「仪表盘」')
    expect(screen.queryByText('仪表盘区块由后续票交付')).not.toBeInTheDocument()
  })

  it('权限服务出错时显示可重试错误，不冒充明确的无权限', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    renderApp('/', {
      gateway: {
        ...base,
        session: {
          canView: async () => {
            throw new Error('会话服务不可用')
          },
          status: async () => ({ mode: 'demo', authenticated: true, devAccount: false }),
          login: async () => {},
          logout: async () => {},
          listSessions: async () => [
            { createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: '2026-01-01T00:00:00.000Z', current: true },
            { createdAt: '2025-12-30T00:00:00.000Z', lastUsedAt: '2025-12-31T00:00:00.000Z', current: false },
          ],
          changePassword: async () => {
            throw new Error('演示模式不支持修改面板密码')
          },
          logoutOtherSessions: async () => {},
        },
      },
    })

    expect(await screen.findByText('无法校验访问权限')).toBeInTheDocument()
    expect(screen.getByText('会话服务不可用')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.queryByText(/无权限查看/)).not.toBeInTheDocument()
  })

  it('重试期间仍关闭闸门，得到明确许可后才呈现页面', async () => {
    const user = userEvent.setup()
    let permit!: (allowed: boolean) => void
    const canView = vi.fn<ElysianGateway['session']['canView']>()
      .mockRejectedValueOnce(new Error('会话服务暂时不可用'))
      .mockImplementationOnce(() => new Promise(resolve => { permit = resolve }))
    const gateway = gatewayDenying('dashboard')
    gateway.session.canView = canView
    render(<GatewayProvider gateway={gateway}><RequireArea area="dashboard" title="仪表盘"><p>受保护内容</p></RequireArea></GatewayProvider>)
    await user.click(await screen.findByRole('button', { name: '重试' }))
    expect(screen.getByRole('status')).toHaveTextContent('正在校验访问权限')
    expect(screen.queryByText('受保护内容')).not.toBeInTheDocument()
    await act(async () => { permit(true) })
    expect(screen.getByText('受保护内容')).toBeInTheDocument()
    expect(canView).toHaveBeenCalledTimes(2)
  })

  it('切换访问区域立即重新关闭闸门，旧请求的结果不会越过新区域', async () => {
    const gateway = gatewayDenying('dashboard')
    let oldResult!: (allowed: boolean) => void
    let nextResult!: (allowed: boolean) => void
    gateway.session.canView = vi.fn<ElysianGateway['session']['canView']>()
      .mockImplementationOnce(() => new Promise(resolve => { oldResult = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { nextResult = resolve }))
    const view = (area: PageArea) => <GatewayProvider gateway={gateway}><RequireArea area={area} title="测试页面"><p>受保护内容</p></RequireArea></GatewayProvider>
    const { rerender } = render(view('dashboard'))
    rerender(view('agent'))
    await act(async () => { oldResult(true) })
    expect(screen.queryByText('受保护内容')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在校验访问权限')
    await act(async () => { nextResult(false) })
    expect(screen.getByText('无权限查看「测试页面」')).toBeInTheDocument()
    expect(screen.queryByText('受保护内容')).not.toBeInTheDocument()
  })

  it('Ely 的加载、错误与拒绝状态共用页面间距，并为窄屏主导航让位', async () => {
    const user = userEvent.setup()
    let fail!: (error: Error) => void
    const gateway = gatewayDenying('agent')
    gateway.session.canView = vi.fn<ElysianGateway['session']['canView']>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
      .mockResolvedValueOnce(false)
    renderApp('/agent', { gateway })
    const classes = ['p-4', 'md:p-6', 'pt-[calc(var(--shell-header-height)+1rem)]', 'md:pt-6']
    expect((await screen.findByText('正在校验访问权限…')).parentElement).toHaveClass(...classes)
    await act(async () => { fail(new Error('连接暂时中断')) })
    expect(screen.getByRole('region', { name: '无法校验访问权限' }).parentElement).toHaveClass(...classes)
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect((await screen.findByText('无权限查看「Ely 工作台」', { exact: true })).parentElement?.parentElement).toHaveClass(...classes)
    expect(screen.queryByText(/本阶段的权限只是接口占位/)).not.toBeInTheDocument()
  })
})
