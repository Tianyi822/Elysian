import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { usePanelStore } from '../../stores/panelStore'
import { renderApp } from '../../test/renderApp'
import type { PanelInfo, PanelTask } from '@elysian/contracts'
import { openPanelAddress } from './panelNavigation'
vi.mock('./panelNavigation', () => ({ openPanelAddress: vi.fn(), reloadPanelPage: vi.fn() }))
const ports = { frontendPort: 48100, backendPort: 48101 }
const info: PanelInfo = { ports, commit: 'a'.repeat(40), buildTime: '', repository: 'Tianyi822/Elysian', available: true, reason: '', activeTask: null, lastTask: null }
const task: PanelTask = { id: 'b'.repeat(32), kind: 'ports', state: 'queued', phase: 'checking', createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', oldPorts: ports, newPorts: { frontendPort: 49000, backendPort: 49001 }, targetCommit: '', error: '' }
beforeEach(() => { vi.clearAllMocks(); usePanelStore.setState({ info: null, task: null, logs: '', offset: 0, hasMore: false, error: null }) })
function gateway() {
  const result = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60000 })
  result.panel = { ...result.panel, info: async () => info, ports: vi.fn(async () => task) }
  return result
}
describe('端口与更新设置', () => {
  it('演示模式明确不可执行，并保留密码表单', async () => {
    renderApp('/settings')
    expect(await screen.findByText('仅支持 systemd 安装版，当前为演示模式')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存并重启' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '检查更新' })).toBeDisabled()
    expect(screen.getByLabelText('当前密码')).toBeInTheDocument()
  })
  it('提交前展示地址变化，校验相同端口并保留输入', async () => {
    const g = gateway(); renderApp('/settings', { gateway: g }); const user = userEvent.setup()
    const front = await screen.findByLabelText('前端端口'); await waitFor(() => expect(front).toHaveValue('48100'))
    await user.clear(front); await user.type(front, '48101'); await user.click(screen.getByRole('button', { name: '保存并重启' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('前端与后端端口不能相同'); expect(g.panel.ports).not.toHaveBeenCalled()
    await user.clear(front); await user.type(front, '49000'); expect(screen.getByText(/保存后地址：.*49000/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '保存并重启' }))
    await waitFor(() => expect(g.panel.ports).toHaveBeenCalledWith({ frontendPort: 49000, backendPort: 48101 }, expect.any(String)))
    expect(await screen.findByText(/等待执行/)).toBeInTheDocument()
  })
  it('真实失败显示原因，重试沿用同一提交编号', async () => {
    const g = gateway(); const submit = vi.fn().mockRejectedValue(new Error('端口已被宿主服务占用')); g.panel.ports = submit
    renderApp('/settings', { gateway: g }); const user = userEvent.setup(); await waitFor(() => expect(screen.getByLabelText('前端端口')).toHaveValue('48100'))
    await user.click(screen.getByRole('button', { name: '保存并重启' })); expect(await screen.findByRole('alert')).toHaveTextContent('端口已被宿主服务占用')
    await user.click(screen.getByRole('button', { name: '保存并重启' })); await waitFor(() => expect(submit).toHaveBeenCalledTimes(2)); expect(submit.mock.calls[0]?.[1]).toBe(submit.mock.calls[1]?.[1])
  })
  it('检查默认分支更新，再以锁定提交执行', async () => {
    const g = gateway(); const sha = 'c'.repeat(40); g.panel.checkUpdate = async () => ({ repository: info.repository, branch: 'release-track', currentCommit: info.commit, targetCommit: sha, available: true, message: '修复说明' }); const update = vi.fn(async () => ({ ...task, kind: 'update' as const, newPorts: ports, targetCommit: sha })); g.panel.update = update
    renderApp('/settings', { gateway: g }); const user = userEvent.setup(); await waitFor(() => expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '检查更新' })); expect(await screen.findByText(`目标提交：${sha}`)).toBeInTheDocument(); await user.click(screen.getByRole('button', { name: '更新并重启' })); await waitFor(() => expect(update).toHaveBeenCalledWith(sha, expect.any(String)))
  })
  it('刷新后恢复后台任务及回滚错误', async () => {
    const g = gateway(); g.panel.info = async () => ({ ...info, lastTask: { ...task, state: 'rolled-back', error: '健康检查失败，已恢复' } })
    renderApp('/settings', { gateway: g }); expect(await screen.findByRole('alert')).toHaveTextContent('健康检查失败，已恢复'); expect(screen.getByRole('link', { name: /打开原地址/ })).toBeInTheDocument()
  })
  it('新入口确认任务提交后跳转，探测使用任务编号', async () => {
    const g = gateway(); g.panel.info = async () => ({ ...info, activeTask: task })
    g.panel.task = async () => ({ task, logs: '检查部署环境\n', nextOffset: 20 })
    g.panel.ready = vi.fn(async () => true)
    renderApp('/settings', { gateway: g })
    await waitFor(() => expect(openPanelAddress).toHaveBeenCalledWith(expect.stringContaining(':49000/settings?maintenanceTask=' + task.id)), { timeout: 4000 })
    expect(g.panel.ready).toHaveBeenCalledWith(expect.stringContaining(':49000'), task.id, expect.any(AbortSignal))
  })
  it('刷新后可读取最后任务的分页日志', async () => {
    const g = gateway(); const finished = { ...task, state: 'succeeded' as const }
    g.panel.info = async () => ({ ...info, lastTask: finished })
    const read = vi.fn().mockResolvedValueOnce({ task: finished, logs: '检查部署环境\n', nextOffset: 20, hasMore: true }).mockResolvedValueOnce({ task: finished, logs: '已完成\n', nextOffset: 30, hasMore: false }); g.panel.task = read
    renderApp('/settings', { gateway: g }); const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '继续读取日志' }))
    await waitFor(() => expect(screen.getByLabelText('维护任务日志')).toHaveTextContent('已完成'))
    expect(read).toHaveBeenLastCalledWith(task.id, 20)
  })
})
