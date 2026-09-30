import { render, screen } from '@testing-library/react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import type { WebsiteProject } from '@elysian/contracts'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useWebsitesStore } from '../../stores/websitesStore'
import { WebsiteDetailSheet } from './WebsiteDetailSheet'

const project: WebsiteProject = { id: 'p', kind: 'html', name: 'docs', pid: 123, containerId: 'a'.repeat(64),
  port: 8088, runtimeVersion: null, rootDir: '/srv/wwwroot/docs', runState: 'running', accessMode: 'domain',
  domain: 'docs.example.com', routeApplied: true, certificate: { issuer: '公开 CA', notAfter: '2027-01-01T00:00:00.000Z', fingerprint256: 'AA', applied: true },
  expiryAt: null, note: null, category: 'development', deployCommand: 'nginx -g daemon off;', gitUrl: null,
  traffic: { todayMb: 0, totalGb: 0 } }

beforeEach(() => useWebsitesStore.setState({ detailTarget: undefined, detailLogs: undefined, detailLogsLoading: false }))

function renderSheet() {
  return render(<Tooltip.Provider><GatewayProvider gateway={createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })}>
    <MemoryRouter initialEntries={['/websites']}><WebsiteDetailSheet /></MemoryRouter>
  </GatewayProvider></Tooltip.Provider>)
}

describe('网站详情', () => {
  it('HTML 容器显示 PID、命令、访问模式与证书下发事实', () => {
    useWebsitesStore.setState({ detailTarget: project, detailLogs: ['Nginx 已启动'] })
    renderSheet()
    expect(screen.getByText('123')).toBeInTheDocument()
    expect(screen.getByText('nginx -g daemon off;')).toBeInTheDocument()
    expect(screen.getByText('域名 HTTPS')).toBeInTheDocument()
    expect(screen.getByText(/已下发 · 有效至/)).toBeInTheDocument()
    expect(screen.getByText('Nginx 已启动')).toBeInTheDocument()
  })

  it('直连项目不显示域名证书', () => {
    useWebsitesStore.setState({ detailTarget: { ...project, accessMode: 'direct', domain: null, certificate: null, routeApplied: false } })
    renderSheet()
    expect(screen.getAllByText(/IP＋端口直连/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/已下发 · 有效至/)).not.toBeInTheDocument()
  })
})
