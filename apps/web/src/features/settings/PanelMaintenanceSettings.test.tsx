import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { PanelNetworkError } from '../../adapters/http/panelHttpAdapter'
import { usePanelStore } from '../../stores/panelStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { renderApp } from '../../test/renderApp'
import type { PanelInfo, PanelTask, PanelUpdate } from '@elysian/contracts'
import { openPanelAddress, reloadPanelPage } from './panelNavigation'
vi.mock('./panelNavigation', () => ({ openPanelAddress: vi.fn(), reloadPanelPage: vi.fn() }))
const ports = { frontendPort: 48100, backendPort: 48101 }
const info: PanelInfo = { ports, commit: 'a'.repeat(40), buildTime: '', repository: 'Tianyi822/Elysian', available: true, reason: '', activeTask: null, lastTask: null }
const task: PanelTask = { id: 'b'.repeat(32), kind: 'ports', state: 'queued', phase: 'checking', createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', oldPorts: ports, newPorts: { frontendPort: 49000, backendPort: 49001 }, targetCommit: '', error: '' }
const releaseUpdate: PanelUpdate = { channel: 'release', releaseTag: 'v1.2.0', repository: info.repository, branch: '', currentCommit: info.commit, targetCommit: 'd'.repeat(40), available: true, message: '正式版说明' }
beforeEach(() => { vi.clearAllMocks(); usePanelStore.setState({ info: null, task: null, logs: '', offset: 0, hasMore: false, error: null }) })
function gateway() {
  const result = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60000 })
  result.panel = { ...result.panel, info: async () => info, ports: vi.fn(async () => task) }
  return result
}
describe('端口与更新设置', () => {
  it('点击标题旁问号显示直观说明，Escape 关闭', async () => {
    renderApp('/settings?tab=maintenance'); const user = userEvent.setup()
    const portsHelp = '前端端口用于打开面板，后端端口供面板内部使用。保存后会重启，页面会短暂断开。'
    expect(screen.queryByText(portsHelp)).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: '面板端口说明' }))
    expect(screen.getByRole('dialog', { name: '面板端口说明' })).toHaveTextContent(portsHelp)
    await user.keyboard('{Escape}')
    expect(screen.queryByText(portsHelp)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '面板更新说明' }))
    expect(screen.getByRole('dialog', { name: '面板更新说明' })).toHaveTextContent('先下载并编译新版本，成功后重启。更新失败会恢复原版本，保留面板数据。')
  })
  it('演示模式明确不可执行，只展示维护设置', async () => {
    renderApp('/settings?tab=maintenance')
    expect(await screen.findByText('仅支持 systemd 安装版，当前为演示模式')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存并重启' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '检查更新' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '更新日志' })).toBeDisabled()
    expect(screen.queryByLabelText('当前密码')).not.toBeInTheDocument()
  })
  it('表单不常驻地址，校验相同端口并保留输入', async () => {
    const g = gateway(); renderApp('/settings?tab=maintenance', { gateway: g }); const user = userEvent.setup()
    const front = await screen.findByLabelText('前端端口'); await waitFor(() => expect(front).toHaveValue('48100'))
    await user.clear(front); await user.type(front, '48101'); await user.click(screen.getByRole('button', { name: '保存并重启' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('前端与后端端口不能相同'); expect(g.panel.ports).not.toHaveBeenCalled()
    await user.clear(front); await user.type(front, '49000'); expect(screen.queryByText(/保存后地址：/)).not.toBeInTheDocument(); expect(screen.queryByText(/当前地址：/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '保存并重启' }))
    await waitFor(() => expect(g.panel.ports).toHaveBeenCalledWith({ frontendPort: 49000, backendPort: 48101 }, expect.any(String)))
    expect(await screen.findByText(/等待执行/)).toBeInTheDocument()
    expect(useNotificationStore.getState().notifications).toContainEqual(expect.objectContaining({ tone: 'info', message: '面板维护任务已提交' }))
  })
  it('真实失败显示原因，重试沿用同一提交编号', async () => {
    const g = gateway(); const submit = vi.fn().mockRejectedValue(new Error('端口已被宿主服务占用')); g.panel.ports = submit
    renderApp('/settings?tab=maintenance', { gateway: g }); const user = userEvent.setup(); await waitFor(() => expect(screen.getByLabelText('前端端口')).toHaveValue('48100'))
    await user.click(screen.getByRole('button', { name: '保存并重启' })); expect(await screen.findByRole('alert')).toHaveTextContent('端口已被宿主服务占用')
    await user.click(screen.getByRole('button', { name: '保存并重启' })); await waitFor(() => expect(submit).toHaveBeenCalledTimes(2)); expect(submit.mock.calls[0]?.[1]).toBe(submit.mock.calls[1]?.[1])
  })
  it('检查默认分支更新，再以锁定提交执行', async () => {
    const g = gateway(); const sha = 'c'.repeat(40); g.panel.checkUpdate = vi.fn(async () => ({ channel: 'commit' as const, releaseTag: '', repository: info.repository, branch: 'release-track', currentCommit: info.commit, targetCommit: sha, available: true, message: '修复说明' })); const update = vi.fn(async () => ({ ...task, kind: 'update' as const, newPorts: ports, targetCommit: sha })); g.panel.update = update
    renderApp('/settings?tab=maintenance', { gateway: g }); const user = userEvent.setup(); await waitFor(() => expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '检查更新' })); expect(await screen.findByText(`目标提交：${sha}`)).toBeInTheDocument(); await user.click(screen.getByRole('button', { name: '更新并重启' })); await waitFor(() => expect(update).toHaveBeenCalledWith({ channel: 'commit', targetCommit: sha, releaseTag: '' }, expect.any(String)))
  })
  it('最新发版按标签检查、展示并提交，更新日志使用相同策略', async () => {
    const g = gateway()
    g.panel.checkUpdate = vi.fn(async () => releaseUpdate)
    g.panel.commits = vi.fn(async () => [])
    g.panel.update = vi.fn(async () => ({ ...task, kind: 'update' as const, newPorts: ports, targetCommit: releaseUpdate.targetCommit, updateChannel: 'release' as const, releaseTag: releaseUpdate.releaseTag }))
    renderApp('/settings?tab=maintenance', { gateway: g })
    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled())
    expect(screen.getByRole('button', { name: '最新提交' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: '最新发版' }))
    await user.click(screen.getByRole('button', { name: '检查更新' }))
    expect(await screen.findByText('可切换至最新正式发版 · v1.2.0')).toBeInTheDocument()
    expect(g.panel.checkUpdate).toHaveBeenCalledWith('release')
    await user.click(screen.getByRole('button', { name: '更新日志' }))
    const dialog = await screen.findByRole('dialog', { name: '更新日志' })
    expect(g.panel.commits).toHaveBeenCalledWith('release')
    expect(dialog).toHaveTextContent('最新正式发版对应的提交记录')
    await user.click(within(dialog).getByRole('button', { name: '关闭更新日志' }))
    await user.click(screen.getByRole('button', { name: '更新并重启' }))
    await waitFor(() => expect(g.panel.update).toHaveBeenCalledWith({ channel: 'release', releaseTag: 'v1.2.0', targetCommit: releaseUpdate.targetCommit }, expect.any(String)))
  })
  it.each([false, true])('切换策略丢弃旧请求的迟到结果，旧请求失败=%s', async (failed) => {
    const g = gateway()
    let resolve!: (value: PanelUpdate) => void
    let reject!: (error: Error) => void
    g.panel.checkUpdate = vi.fn().mockImplementationOnce(() => new Promise<PanelUpdate>((done, error) => { resolve = done; reject = error })).mockResolvedValueOnce(releaseUpdate)
    renderApp('/settings?tab=maintenance', { gateway: g })
    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '检查更新' }))
    await user.click(screen.getByRole('button', { name: '最新发版' }))
    expect(screen.getByRole('button', { name: '更新并重启' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '检查更新' }))
    expect(await screen.findByText('可切换至最新正式发版 · v1.2.0')).toBeInTheDocument()
    await act(async () => {
      if (failed) reject(new Error('旧策略请求失败'))
      else resolve({ ...releaseUpdate, channel: 'commit', branch: 'main', releaseTag: '' })
    })
    expect(screen.getByText('可切换至最新正式发版 · v1.2.0')).toBeInTheDocument()
    expect(screen.queryByText('旧策略请求失败')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '最新提交' }))
    expect(screen.queryByText('可切换至最新正式发版 · v1.2.0')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '更新并重启' })).toBeDisabled()
  })
  it.each([
    { ...releaseUpdate, releaseTag: '', targetCommit: '', available: false, message: '上游仓库暂无正式发版', expected: '上游仓库暂无正式发版' },
    { ...releaseUpdate, targetCommit: info.commit, available: false, expected: '当前已是最新正式发版 · v1.2.0' },
  ])('发版不可更新时禁用提交：$expected', async ({ expected, ...result }) => {
    const g = gateway(); g.panel.checkUpdate = vi.fn(async () => result)
    renderApp('/settings?tab=maintenance', { gateway: g }); const user = userEvent.setup()
    await waitFor(() => expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '最新发版' }))
    await user.click(screen.getByRole('button', { name: '检查更新' }))
    expect(await screen.findByText(expected)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '更新并重启' })).toBeDisabled()
  })
  it('再次检查失败后不允许提交上一次的目标', async () => {
    const g = gateway(); g.panel.checkUpdate = vi.fn().mockResolvedValueOnce(releaseUpdate).mockRejectedValueOnce(new Error('GitHub 请求失败'))
    renderApp('/settings?tab=maintenance', { gateway: g }); const user = userEvent.setup()
    await waitFor(() => expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '最新发版' }))
    await user.click(screen.getByRole('button', { name: '检查更新' }))
    expect(await screen.findByText('可切换至最新正式发版 · v1.2.0')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '检查更新' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub 请求失败')
    expect(screen.getByRole('button', { name: '更新并重启' })).toBeDisabled()
  })
  it('刷新后恢复后台任务及回滚错误', async () => {
    const g = gateway(); g.panel.info = async () => ({ ...info, lastTask: { ...task, state: 'rolled-back', error: '健康检查失败，已恢复' } })
    renderApp('/settings?tab=maintenance', { gateway: g }); expect(await screen.findByRole('alert')).toHaveTextContent('健康检查失败，已恢复'); expect(screen.getByRole('link', { name: /打开原地址/ })).toBeInTheDocument()
  })
  it('新入口确认任务提交后跳转，探测使用任务编号', async () => {
    const g = gateway(); g.panel.info = async () => ({ ...info, activeTask: task })
    g.panel.task = async () => ({ task, logs: '检查部署环境\n', nextOffset: 20 })
    g.panel.ready = vi.fn(async () => true)
    renderApp('/settings?tab=maintenance', { gateway: g })
    await waitFor(() => expect(openPanelAddress).toHaveBeenCalledWith(expect.stringContaining(':49000/settings?maintenanceTask=' + task.id)), { timeout: 4000 })
    expect(g.panel.ready).toHaveBeenCalledWith(expect.stringContaining(':49000'), task.id, expect.any(AbortSignal))
  })
  it('刷新后可读取最后任务的分页日志', async () => {
    const g = gateway(); const finished = { ...task, state: 'succeeded' as const }
    g.panel.info = async () => ({ ...info, lastTask: finished })
    const read = vi.fn().mockResolvedValueOnce({ task: finished, logs: '检查部署环境\n', nextOffset: 20, hasMore: true }).mockResolvedValueOnce({ task: finished, logs: '已完成\n', nextOffset: 30, hasMore: false }); g.panel.task = read
    renderApp('/settings?tab=maintenance', { gateway: g }); const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '继续读取日志' }))
    await waitFor(() => expect(screen.getByLabelText('维护任务日志')).toHaveTextContent('已完成'))
    expect(read).toHaveBeenLastCalledWith(task.id, 20)
    expect(useNotificationStore.getState().notifications).toContainEqual(expect.objectContaining({ tone: 'success', message: '面板维护已完成' }))
  })
  it('更新日志窗口列出上游提交并只标注命中当前提交的那一条', async () => {
    const g = gateway()
    g.panel.commits = vi.fn(async () => [
      { sha: info.commit, message: '防火墙按运行模式保护实际入口', time: '2026-10-03T12:00:00Z' },
      { sha: 'e'.repeat(40), message: '部署任务标注项目状态', time: '2026-10-02T12:00:00Z' },
    ])
    renderApp('/settings?tab=maintenance', { gateway: g })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '更新日志' }))
    const dialog = await screen.findByRole('dialog', { name: '更新日志' })
    expect(within(dialog).getByText('防火墙按运行模式保护实际入口')).toBeInTheDocument()
    expect(within(dialog).getByText('部署任务标注项目状态')).toBeInTheDocument()
    expect(within(dialog).getAllByText('当前版本')).toHaveLength(1)
    expect(within(dialog).getByText(info.commit.slice(0, 7))).toBeInTheDocument()
  })
  it('更新日志读取失败把原因留在窗口内，重试再次拉取', async () => {
    const g = gateway()
    const commits = vi.fn().mockRejectedValueOnce(new Error('GitHub 不可达，请检查网络或 API 限额')).mockResolvedValueOnce([])
    g.panel.commits = commits
    renderApp('/settings?tab=maintenance', { gateway: g })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '更新日志' }))
    const dialog = await screen.findByRole('dialog', { name: '更新日志' })
    expect(await within(dialog).findByRole('region', { name: '更新日志读取失败' })).toHaveTextContent('GitHub 不可达，请检查网络或 API 限额')
    expect(useNotificationStore.getState().notifications).toContainEqual(expect.objectContaining({ tone: 'danger', message: '更新日志读取失败：GitHub 不可达，请检查网络或 API 限额' }))
    await user.click(within(dialog).getByRole('button', { name: '重试' }))
    expect(await within(dialog).findByText('没有可展示的提交')).toBeInTheDocument()
    expect(commits).toHaveBeenCalledTimes(2)
  })
  it('更新日志窗口右上角关闭与 Escape 都能关闭', async () => {
    const g = gateway()
    g.panel.commits = vi.fn(async () => [])
    renderApp('/settings?tab=maintenance', { gateway: g })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '更新日志' }))
    const dialog = screen.getByRole('dialog', { name: '更新日志' })
    await user.click(within(dialog).getByRole('button', { name: '关闭更新日志' }))
    expect(screen.queryByRole('dialog', { name: '更新日志' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '更新日志' }))
    expect(screen.getByRole('dialog', { name: '更新日志' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '更新日志' })).not.toBeInTheDocument()
  })
  const commitUpdate = { channel: 'commit' as const, releaseTag: '', repository: info.repository, branch: 'main', currentCommit: info.commit, targetCommit: 'c'.repeat(40), available: true, message: '修复说明' }
  it('提交更新期间按钮立即进入提交中并阻止重复提交', async () => {
    const g = gateway()
    g.panel.checkUpdate = vi.fn(async () => commitUpdate)
    let resolveUpdate!: (value: PanelTask) => void
    g.panel.update = vi.fn(() => new Promise<PanelTask>((done) => { resolveUpdate = done }))
    renderApp('/settings?tab=maintenance', { gateway: g }); const user = userEvent.setup()
    await waitFor(() => expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '检查更新' }))
    expect(await screen.findByText(`目标提交：${commitUpdate.targetCommit}`)).toBeInTheDocument()
    const submitButton = screen.getByRole('button', { name: '更新并重启' })
    await user.click(submitButton)
    expect(submitButton).toBeDisabled()
    expect(submitButton).toHaveTextContent('正在提交…')
    expect(screen.getByRole('button', { name: '检查更新' })).toBeDisabled()
    expect(g.panel.update).toHaveBeenCalledTimes(1)
    await act(async () => { resolveUpdate({ ...task, kind: 'update' as const, newPorts: ports, targetCommit: commitUpdate.targetCommit }) })
    expect(useNotificationStore.getState().notifications).toContainEqual(expect.objectContaining({ tone: 'info', message: '面板维护任务已提交' }))
  })
  it('提交失败在更新区块留下持久错误行并重读配置重挂任务', async () => {
    const g = gateway()
    g.panel.checkUpdate = vi.fn(async () => commitUpdate)
    g.panel.info = vi.fn(async () => info)
    g.panel.update = vi.fn().mockRejectedValue(new Error('面板正忙，请稍后重试'))
    renderApp('/settings?tab=maintenance', { gateway: g }); const user = userEvent.setup()
    await waitFor(() => expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '检查更新' }))
    expect(await screen.findByText(`目标提交：${commitUpdate.targetCommit}`)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '更新并重启' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('面板正忙，请稍后重试')
    expect(useNotificationStore.getState().notifications).not.toContainEqual(expect.objectContaining({ tone: 'danger', message: '面板正忙，请稍后重试' }))
    // 失败分支重读一次配置：服务端凭 requestId 幂等创建的任务会被重新挂回页面。
    expect(g.panel.info).toHaveBeenCalledTimes(2)
  })
  it('轮询收到 HTTP 错误立即显示服务端原因，不计断连预算', async () => {
    const g = gateway()
    g.panel.info = async () => ({ ...info, activeTask: { ...task, kind: 'update' as const, newPorts: ports } })
    g.panel.task = vi.fn().mockRejectedValue(new Error('维护任务记录损坏'))
    renderApp('/settings?tab=maintenance', { gateway: g })
    expect(await screen.findByRole('alert')).toHaveTextContent('维护任务记录损坏')
    expect(screen.queryByText(/等待面板恢复连接超时/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新等待连接' })).not.toBeInTheDocument()
  })
  it('维护进程已退出的活动任务提示疑似中断', async () => {
    const g = gateway()
    const interrupted = { ...task, kind: 'update' as const, newPorts: ports, workerDead: true }
    g.panel.info = async () => ({ ...info, activeTask: interrupted })
    g.panel.task = vi.fn().mockResolvedValue({ task: interrupted, logs: '', nextOffset: 0 })
    renderApp('/settings?tab=maintenance', { gateway: g })
    expect(await screen.findByText(/维护进程已退出/)).toBeInTheDocument()
  })
  it('更新成功先核对运行版本，不一致不自动刷新并提供手动重载', async () => {
    const g = gateway(); const sha = commitUpdate.targetCommit
    const updateTask = { ...task, kind: 'update' as const, newPorts: ports, targetCommit: sha }
    g.panel.info = async () => ({ ...info, activeTask: updateTask })
    // 页面挂载会读取数次任务，先保持活动；轮询确认执行中之后才放行终态。
    let finished = false
    g.panel.task = vi.fn(async () => finished
      ? { task: { ...updateTask, state: 'succeeded' as const }, logs: '', nextOffset: 0 }
      : { task: updateTask, logs: '', nextOffset: 0 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, commit: 'f'.repeat(40) }))))
    renderApp('/settings?tab=maintenance', { gateway: g })
    await screen.findByText(/等待执行|正在执行/)
    finished = true
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent('与目标提交不一致')
    expect(vi.mocked(reloadPanelPage)).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '重新加载面板' })).toBeInTheDocument()
    vi.unstubAllGlobals()
  })
  it('运行版本与目标提交一致时自动刷新页面', async () => {
    const g = gateway(); const sha = commitUpdate.targetCommit
    const updateTask = { ...task, kind: 'update' as const, newPorts: ports, targetCommit: sha }
    g.panel.info = async () => ({ ...info, activeTask: updateTask })
    let finished = false
    g.panel.task = vi.fn(async () => finished
      ? { task: { ...updateTask, state: 'succeeded' as const }, logs: '', nextOffset: 0 }
      : { task: updateTask, logs: '', nextOffset: 0 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, commit: sha }))))
    renderApp('/settings?tab=maintenance', { gateway: g })
    await screen.findByText(/等待执行|正在执行/)
    finished = true
    await waitFor(() => expect(vi.mocked(reloadPanelPage)).toHaveBeenCalled(), { timeout: 4000 })
    vi.unstubAllGlobals()
  })
  it('断连超时后转健康探测自动重连，更新任务不引导新地址', async () => {
    vi.useFakeTimers()
    try {
      const g = gateway(); const sha = commitUpdate.targetCommit
      const updateTask = { ...task, kind: 'update' as const, newPorts: ports, targetCommit: sha }
      g.panel.info = vi.fn(async () => ({ ...info, activeTask: updateTask }))
      g.panel.task = vi.fn().mockRejectedValue(new PanelNetworkError('面板连接失败或响应无效，请稍后重试'))
      renderApp('/settings?tab=maintenance', { gateway: g })
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      await act(async () => { await vi.advanceTimersByTimeAsync(121000) })
      expect(screen.getByText(/等待面板恢复连接超时/)).toBeInTheDocument()
      expect(screen.queryByText(/打开下方新地址/)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '重新加载面板' })).toBeInTheDocument()
      // 面板恢复（健康探测返回目标版本）→ 自动重连轮询 → 亲见 succeeded 且版本一致才刷新。
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, commit: sha }))))
      g.panel.task = vi.fn().mockResolvedValue({ task: { ...updateTask, state: 'succeeded' as const }, logs: '', nextOffset: 0 })
      await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
      // 恢复触发的重渲染在上一段 act 结束时完成，重连轮询的定时器在这段推进里触发。
      await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
      expect(vi.mocked(reloadPanelPage)).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})
