import { createRef } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { PanelTask } from '@elysian/contracts'
import { PanelMaintenanceProgress, panelMaintenancePhaseLabel } from './PanelMaintenanceProgress'
import { PanelMaintenanceLog } from './PanelMaintenanceLog'

const task: PanelTask = {
  id: 'a'.repeat(32), kind: 'update', state: 'running', phase: 'downloading-release',
  createdAt: '2026-11-12T08:06:29Z', updatedAt: '2026-11-12T08:07:29Z',
  oldPorts: { frontendPort: 48100, backendPort: 48101 }, newPorts: { frontendPort: 48100, backendPort: 48101 },
  targetCommit: 'b'.repeat(40), updateSource: 'github', updateChannel: 'release', releaseTag: 'v0.0.5', error: '', workerStatus: 'alive',
  download: { fileName: 'elysian-linux-amd64.tar.gz', status: 'downloading', completedBytes: 4 * 1024 ** 2, totalBytes: 16 * 1024 ** 2, bytesPerSecond: 512 * 1024, updatedAt: '2026-11-12T08:07:29Z' },
}

describe('维护图形进度与日志', () => {
  it('使用 EasyUI Stepper 展示真实下载进度与当前阶段', () => {
    render(<PanelMaintenanceProgress task={task} />)
    expect(screen.getByRole('progressbar', { name: '安装包下载进度' })).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '4.0 MiB / 16.0 MiB，下载安装包')
    expect(screen.getByText('平均 512.0 KiB/s')).toBeInTheDocument()
    const steps = screen.getByRole('list', { name: '维护阶段' })
    expect(within(steps).getByRole('listitem', { name: /检查运行环境.*已完成/ })).toBeInTheDocument()
    expect(within(steps).getByRole('listitem', { name: /下载安装包.*进行中/ })).toHaveAttribute('aria-current', 'step')
    expect(within(steps).getByRole('listitem', { name: /健康检查.*待执行/ })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '安装包校验结果' })).not.toBeInTheDocument()
  })
  it('下载完成后单独进入校验步骤，失败状态不误报校验通过', () => {
    const verifying = { ...task, download: { ...task.download!, completedBytes: task.download!.totalBytes, status: 'verifying' as const } }
    const view = render(<PanelMaintenanceProgress task={verifying} />)
    expect(screen.getByText('正在校验安装包')).toBeInTheDocument()
    expect(screen.queryByText('安装包已校验')).not.toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: /校验安装包.*进行中/ })).toHaveAttribute('aria-current', 'step')
    expect(screen.getByText(/正在比对发布包 SHA256/)).toBeInTheDocument()
    view.rerender(<PanelMaintenanceProgress task={{ ...verifying, state: 'failed', phase: 'finished', failedPhase: 'downloading-release' }} />)
    expect(screen.getByText('安装包校验未完成')).toBeInTheDocument()
    expect(screen.queryByText('此阶段未能完成。具体原因见维护任务错误信息和日志。')).not.toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: /校验安装包.*失败/ })).toHaveAttribute('aria-current', 'step')
    expect(screen.getByRole('listitem', { name: /健康检查.*待执行/ })).toBeInTheDocument()
  })
  it('日志分批到达时补充版本和来源，提交 ID 始终只在日志中显示', () => {
    const view = render(<PanelMaintenanceProgress task={task} logs="更新来源：GitHub" />)
    expect(screen.queryByText('更新来源：GitHub')).not.toBeInTheDocument()
    expect(screen.getByText(task.releaseTag!)).toBeInTheDocument()
    expect(screen.queryByText(task.targetCommit)).not.toBeInTheDocument()
    view.rerender(<PanelMaintenanceProgress task={task} logs={`更新来源：GitHub；更新策略：最新发版 ${task.releaseTag}；目标提交：${task.targetCommit}\n`} />)
    expect(screen.queryByText(task.releaseTag!)).not.toBeInTheDocument()
    expect(screen.queryByText(task.targetCommit)).not.toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
  })
  it('服务端返回 ready 后显示真实校验项目，并在原下载阶段过渡到准备新版本', async () => {
    const verifying = { ...task, download: { ...task.download!, completedBytes: task.download!.totalBytes, status: 'verifying' as const } }
    const view = render(<PanelMaintenanceProgress task={verifying} />)
    const ready = { ...verifying, download: { ...verifying.download!, status: 'ready' as const } }

    view.rerender(<PanelMaintenanceProgress task={ready} />)

    expect(panelMaintenancePhaseLabel(ready)).toBe('准备新版本')
    expect(screen.getByRole('listitem', { name: /准备新版本.*进行中/ })).toHaveAttribute('aria-current', 'step')
    expect(screen.getByRole('region', { name: '安装包校验结果' })).toBeInTheDocument()
    expect(screen.getByText('发布包 SHA256 与发布信息一致')).toBeInTheDocument()
    expect(screen.getByText('目标提交与 release.json 一致')).toBeInTheDocument()
    expect(screen.getByText('发布清单中的文件摘要已核对')).toBeInTheDocument()
    expect(screen.getByText('可执行文件架构与当前主机一致')).toBeInTheDocument()
    expect(await screen.findByText('安装包校验结果已返回通过，正在准备更新资源。')).toBeInTheDocument()
  })
  it('旧源码更新任务仍按源码下载与构建阶段显示', () => {
    render(<PanelMaintenanceProgress task={{ ...task, phase: 'downloading', download: undefined }} />)
    expect(screen.getByRole('listitem', { name: /下载源码.*进行中/ })).toHaveAttribute('aria-current', 'step')
    expect(screen.queryByRole('listitem', { name: /校验安装包/ })).not.toBeInTheDocument()
  })
  it.each([{ workerStatus: 'unknown' as const }, { workerDead: true }, { paused: true }])('进程或连接未确认时冻结活动图形：%j', ({ paused, ...changes }) => {
    const { container } = render(<PanelMaintenanceProgress task={{ ...task, ...changes }} paused={paused} />)
    expect(screen.getByText('等待进度同步')).toBeInTheDocument()
    expect(screen.queryByText(/平均/)).not.toBeInTheDocument()
    expect(container.querySelector('.motion-safe\\:animate-spin')).toBeNull()
    expect(container.querySelector('.motion-safe\\:animate-pull-progress')).toBeNull()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
  })
  it('旧任务无字节数据时显示等待信息，不估算下载百分比', () => {
    render(<PanelMaintenanceProgress task={{ ...task, download: undefined }} />)
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByText(/等待下载数据/)).toBeInTheDocument()
  })
  it('历史失败任务没有记录失败阶段时不虚构阶段状态', () => {
    render(<PanelMaintenanceProgress task={{ ...task, state: 'failed', phase: 'finished', failedPhase: undefined, download: undefined }} />)
    expect(screen.getByText('历史任务未记录结束前的阶段。')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '维护阶段' })).not.toBeInTheDocument()
  })
  it('日志时间独立显示、旧长行拆开，复制保留原始日志', async () => {
    const user = userEvent.setup()
    const logs = '2026-11-12T08:06:29Z 检查部署环境\n更新来源：GitHub；更新策略：最新发版 v0.0.5；目标提交：' + 'b'.repeat(40) + '\n维护失败：下载超时\n'
    render(<PanelMaintenanceLog logs={logs} viewportRef={createRef()} />)
    const viewport = screen.getByRole('region', { name: '维护任务日志' })
    expect(within(viewport).getByText('检查部署环境')).toBeInTheDocument()
    expect(within(viewport).getByText('更新来源：GitHub').parentElement?.children).toHaveLength(3)
    expect(within(viewport).getByText('维护失败：下载超时').parentElement).toHaveClass('text-danger')
    expect(viewport.querySelector('time')).toHaveAttribute('datetime', '2026-11-12T08:06:29Z')
    await user.click(screen.getByRole('button', { name: '复制日志' }))
    expect(await navigator.clipboard.readText()).toBe(logs)
  })
})
