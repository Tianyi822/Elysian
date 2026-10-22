import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DependencyProbeReport } from '@elysian/contracts'
import { createMockGateway } from '../../adapters/mock/gateway'
import { resetWebsitesData } from '../../adapters/mock/websitesData'
import { useDependencyProbeStore } from '../../stores/dependencyProbeStore'
import { useWebsitesStore } from '../../stores/websitesStore'
import { renderApp } from '../../test/renderApp'

beforeEach(() => {
  resetWebsitesData()
  useWebsitesStore.setState({ status: 'idle', projects: [], createDialogOpen: false, refreshing: false, errorMessage: undefined, proxyStatus: { state: 'active', detail: null } })
  useDependencyProbeStore.getState().reset()
})

const READY: DependencyProbeReport = { docker: { state: 'ok', detail: null }, caddy: { state: 'ok', detail: null } }
const CADDY_MISSING: DependencyProbeReport = { docker: READY.docker, caddy: { state: 'missing', detail: '未接通' } }

describe('网站页依赖入口', () => {
  it('Caddy 缺失时显示添加项目，不显示访问配置', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    vi.spyOn(gateway.dependencies, 'probe').mockResolvedValue(CADDY_MISSING)
    renderApp('/websites', { gateway })
    expect(await screen.findByRole('button', { name: '添加项目' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '访问配置' })).not.toBeInTheDocument()
  })

  it('Caddy 就绪后开放访问配置入口', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    vi.spyOn(gateway.dependencies, 'probe').mockResolvedValue(READY)
    renderApp('/websites', { gateway })
    expect(await screen.findByRole('button', { name: '访问配置' })).toBeInTheDocument()
  })

  it.each(['missing', 'error', 'http'] as const)('Caddy %s 后点击刷新重检，恢复访问配置', async (failure) => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const probe = vi.spyOn(gateway.dependencies, 'probe')
    if (failure === 'http') probe.mockRejectedValueOnce(new Error('探测网络失败'))
    else probe.mockResolvedValueOnce({ docker: READY.docker, caddy: { state: failure, detail: '通道异常' } })
    probe.mockResolvedValue(READY)
    const list = vi.spyOn(gateway.websites, 'list')
    renderApp('/websites', { gateway })
    await screen.findByRole('button', { name: '添加项目' })
    await waitFor(() => expect(useDependencyProbeStore.getState().status).toBe(failure === 'http' ? 'error' : 'checked'))
    expect(screen.queryByRole('button', { name: '访问配置' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByRole('button', { name: '访问配置' })).toBeInTheDocument()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: '安装 Caddy' })).not.toBeInTheDocument()
  })

  it('网站错误态重试同时恢复业务数据和依赖报告', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const list = vi.spyOn(gateway.websites, 'list').mockRejectedValueOnce(new Error('Docker 未接通'))
    const probe = vi.spyOn(gateway.dependencies, 'probe').mockResolvedValueOnce(CADDY_MISSING).mockResolvedValue(READY)
    renderApp('/websites', { gateway })
    await screen.findByText('网站数据加载失败')
    await waitFor(() => expect(useDependencyProbeStore.getState().status).toBe('checked'))
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('button', { name: '访问配置' })).toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('网站列表刷新失败不阻止依赖恢复', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const probe = vi.spyOn(gateway.dependencies, 'probe').mockResolvedValueOnce(CADDY_MISSING).mockResolvedValue(READY)
    renderApp('/websites', { gateway })
    await screen.findByRole('button', { name: '添加项目' })
    await waitFor(() => expect(useDependencyProbeStore.getState().status).toBe('checked'))
    vi.spyOn(gateway.websites, 'list').mockRejectedValueOnce(new Error('列表刷新失败'))
    await userEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByRole('button', { name: '访问配置' })).toBeInTheDocument()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('依赖刷新失败保留旧报告但隐藏访问配置，按钮等待探测结束', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    let reject: ((error: Error) => void) | undefined
    vi.spyOn(gateway.dependencies, 'probe').mockResolvedValueOnce(READY).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const list = vi.spyOn(gateway.websites, 'list')
    renderApp('/websites', { gateway })
    await screen.findByRole('button', { name: '访问配置' })
    await userEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled()
    reject?.(new Error('探测网络失败'))
    await waitFor(() => expect(useDependencyProbeStore.getState().status).toBe('error'))
    expect(useDependencyProbeStore.getState().report).toEqual(READY)
    expect(screen.queryByRole('button', { name: '访问配置' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
    expect(list).toHaveBeenCalledTimes(2)
  })
})
