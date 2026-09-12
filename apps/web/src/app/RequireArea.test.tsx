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
    },
  }
}

describe('页面级访问闸门', () => {
  it('默认全部放行，页面正常渲染', async () => {
    renderApp('/incidents')
    expect(await screen.findByRole('table', { name: '事件列表' })).toBeInTheDocument()
    expect(screen.queryByText('无访问权限')).not.toBeInTheDocument()
  })

  it('无权限时给出明确的无权限状态，而不是空白页', async () => {
    renderApp('/incidents', { gateway: gatewayDenying('incidents') })

    expect(await screen.findByText('无访问权限')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: '事件中心' })).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: '事件列表' })).not.toBeInTheDocument()
  })

  it('只挡住无权限的那个区域，其他页面不受影响', async () => {
    const gateway = gatewayDenying('audit')

    const audit = renderApp('/audit', { gateway })
    expect(await screen.findByText('无访问权限')).toBeInTheDocument()
    audit.unmount()

    renderApp('/skills', { gateway })
    expect(await screen.findByRole('table', { name: '技能清单' })).toBeInTheDocument()
  })

  it('权限判定失败时按无权限处理，宁可挡住也不放行', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    renderApp('/approvals', {
      gateway: {
        ...base,
        session: {
          canView: async () => {
            throw new Error('会话服务不可用')
          },
        },
      },
    })

    expect(await screen.findByText('无访问权限')).toBeInTheDocument()
  })
})
