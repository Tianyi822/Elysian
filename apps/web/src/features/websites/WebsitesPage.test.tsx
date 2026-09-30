import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { resetWebsitesData } from '../../adapters/mock/websitesData'
import { useDependencyGuideStore } from '../../stores/dependencyGuideStore'
import { useWebsitesStore } from '../../stores/websitesStore'
import { renderApp } from '../../test/renderApp'

beforeEach(() => {
  resetWebsitesData()
  useWebsitesStore.setState({ status: 'idle', projects: [], createDialogOpen: false, proxyStatus: { state: 'active', detail: null } })
  useDependencyGuideStore.setState({ report: undefined, status: 'idle', dismissedDocker: false, dismissedCaddy: false })
})

describe('网站页依赖入口', () => {
  it('Caddy 缺失时仍显示添加项目与访问配置，并提供安装入口', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    useDependencyGuideStore.setState({ report: { docker: { state: 'ok', detail: null }, caddy: { state: 'missing', detail: '未安装' } }, status: 'checked' })
    renderApp('/websites', { gateway })
    expect(await screen.findByRole('button', { name: '安装 Caddy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加项目' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '访问配置' })).toBeInTheDocument()
  })
})
