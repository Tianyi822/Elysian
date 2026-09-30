import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createMockGateway } from '../adapters/mock/gateway'
import type { ElysianGateway, PageArea } from '../contracts/adapters'
import { renderApp } from '../test/renderApp'

function gatewayDenying(area: PageArea): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  return {
    ...base,
    session: {
      canView: async (requested) => requested !== area,
      status: async () => ({ mode: 'demo', authenticated: true, devAccount: false }),
      login: async () => {},
      logout: async () => {},
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

    expect(await screen.findByText(/无权限查看/)).toBeInTheDocument()
    expect(screen.queryByText('仪表盘区块由后续票交付')).not.toBeInTheDocument()
  })

  it('权限判定失败时按无权限处理，宁可挡住也不放行', async () => {
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
        },
      },
    })

    expect(await screen.findByText(/无权限查看/)).toBeInTheDocument()
  })
})
