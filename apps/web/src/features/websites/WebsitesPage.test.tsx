import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { resetWebsitesData } from '../../adapters/mock/websitesData'
import { useDependencyProbeStore } from '../../stores/dependencyProbeStore'
import { useWebsitesStore } from '../../stores/websitesStore'
import { renderApp } from '../../test/renderApp'

beforeEach(() => {
  resetWebsitesData()
  useWebsitesStore.setState({ status: 'idle', projects: [], createDialogOpen: false, proxyStatus: { state: 'active', detail: null } })
  useDependencyProbeStore.setState({ report: undefined, status: 'idle', rechecking: false })
})

describe('网站页依赖入口', () => {
  it('Caddy 缺失时显示添加项目，不显示访问配置', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    useDependencyProbeStore.setState({ report: { docker: { state: 'ok', detail: null }, caddy: { state: 'missing', detail: '未安装' } }, status: 'checked' })
    renderApp('/websites', { gateway })
    expect(await screen.findByRole('button', { name: '添加项目' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '访问配置' })).not.toBeInTheDocument()
  })

  it('Caddy 就绪后开放访问配置入口', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    useDependencyProbeStore.setState({ report: { docker: { state: 'ok', detail: null }, caddy: { state: 'ok', detail: null } }, status: 'checked' })
    renderApp('/websites', { gateway })
    expect(await screen.findByRole('button', { name: '访问配置' })).toBeInTheDocument()
  })
})
