import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PanelUpdatePreflight } from '@elysian/contracts'
import { mockPanelAdapter } from '../../adapters/mock/panelMock'
import { PanelResourcePreflightDialog } from './PanelResourcePreflightDialog'

const target = { source: 'github' as const, channel: 'commit' as const, targetCommit: 'a'.repeat(40), releaseTag: '' }
const candidate = `container:${'b'.repeat(64)}`
function report(): PanelUpdatePreflight { return {
  id: 'c'.repeat(32), expiresAt: new Date(Date.now() + 300000).toISOString(),
  memory: { totalBytes: 2 * 1024 ** 3, availableBytes: 512 * 1024 ** 2, requiredBytes: 1536 * 1024 ** 2, swapTotalBytes: 0, swapFreeBytes: 0 },
  disk: { availableBytes: 10 * 1024 ** 3 }, load: [1, 0.5, 0.2], activeAgentRuns: 2,
  candidates: [{ id: candidate, kind: 'container', name: 'mysql', memoryBytes: 512 * 1024 ** 2, recommended: true }, { id: 'service:docker.service', kind: 'service', name: 'Docker', memoryBytes: null, recommended: false, disabledReason: '关键运行时服务' }],
  needsRelease: true, stopPanelRecommended: true,
} }
describe('更新资源确认', () => {
  it('预编译更新隐藏停机选项，并提交无停机范围的资源计划', async () => {
    const preflight = { ...report(), needsRelease: false, stopPanelRecommended: false, candidates: [], memory: { ...report().memory, availableBytes: 1202 * 1024 ** 2, requiredBytes: 128 * 1024 ** 2 } }, onConfirm = vi.fn()
    render(<PanelResourcePreflightDialog precompiled target={target} adapter={{ ...mockPanelAdapter, preflightUpdate: async () => preflight }} onConfirm={onConfirm} onClose={() => {}} />)
    expect(await screen.findByText('1202 MiB / 128 MiB')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '确认更新资源' })).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: '确认并更新' }))
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ preflightId: preflight.id, targets: [], stopPanel: false })
  })
  it('展示实测与停机影响，只提交管理员确认后的精确清单', async () => {
    const preflight = report(), onConfirm = vi.fn(), onClose = vi.fn()
    const read = vi.fn(async () => preflight)
    render(<PanelResourcePreflightDialog target={target} adapter={{ ...mockPanelAdapter, preflightUpdate: read }} onConfirm={onConfirm} onClose={onClose} />)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(await screen.findByText('512 MiB / 1536 MiB')).toBeInTheDocument()
    expect(screen.getByText(/构建期间面板暂时不可访问/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Docker/ })).toBeDisabled()
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: /mysql/ }))
    await user.click(screen.getByRole('button', { name: '确认并更新' }))
    expect(onConfirm).toHaveBeenCalledWith({ preflightId: preflight.id, targets: [], stopPanel: true })
    expect(read).toHaveBeenCalledWith(target)
  })
  it('预检失败和过期都不能确认，可重新检查', async () => {
    const expired = { ...report(), expiresAt: '2000-01-01T00:00:00Z' }, read = vi.fn().mockRejectedValueOnce(new Error('无法读取内存')).mockResolvedValue(expired), onConfirm = vi.fn()
    render(<PanelResourcePreflightDialog target={target} adapter={{ ...mockPanelAdapter, preflightUpdate: read }} onConfirm={onConfirm} onClose={() => {}} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取内存')
    expect(screen.getByRole('button', { name: '确认并更新' })).toBeDisabled()
    await userEvent.setup().click(screen.getByRole('button', { name: '重新检查资源' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('资源预检已过期'))
    expect(screen.getByRole('button', { name: '确认并更新' })).toBeDisabled()
    expect(onConfirm).not.toHaveBeenCalled()
  })
  it('内存充足时禁用所有停机选项并只提交空清单', async () => {
    const preflight = { ...report(), needsRelease: false, memory: { ...report().memory, availableBytes: 1800 * 1024 ** 2 } }, onConfirm = vi.fn()
    render(<PanelResourcePreflightDialog target={target} adapter={{ ...mockPanelAdapter, preflightUpdate: async () => preflight }} onConfirm={onConfirm} onClose={() => {}} />)
    expect(await screen.findByText('1800 MiB / 1536 MiB')).toBeInTheDocument()
    for (const checkbox of screen.getAllByRole('checkbox')) {
      expect(checkbox).toBeDisabled()
      expect(checkbox).not.toBeChecked()
    }
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: /mysql/ }))
    await user.click(screen.getByRole('checkbox', { name: /面板及 Agent 会话/ }))
    await user.click(screen.getByRole('button', { name: '确认并更新' }))
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ preflightId: preflight.id, targets: [], stopPanel: false })
  })
})
