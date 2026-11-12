import { createRef } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { PanelTask } from '@elysian/contracts'
import { PanelMaintenanceProgress } from './PanelMaintenanceProgress'
import { PanelMaintenanceLog } from './PanelMaintenanceLog'

const task: PanelTask = {
  id: 'a'.repeat(32), kind: 'update', state: 'running', phase: 'downloading-release',
  createdAt: '2026-11-12T08:06:29Z', updatedAt: '2026-11-12T08:07:29Z',
  oldPorts: { frontendPort: 48100, backendPort: 48101 }, newPorts: { frontendPort: 48100, backendPort: 48101 },
  targetCommit: 'b'.repeat(40), updateSource: 'github', updateChannel: 'release', releaseTag: 'v0.0.5', error: '', workerStatus: 'alive',
  download: { fileName: 'elysian-linux-amd64.tar.gz', status: 'downloading', completedBytes: 4 * 1024 ** 2, totalBytes: 16 * 1024 ** 2, bytesPerSecond: 512 * 1024, updatedAt: '2026-11-12T08:07:29Z' },
}

describe('维护图形进度与日志', () => {
  it('以真实字节展示下载比例及速率，阶段进度独立于下载百分比', () => {
    render(<PanelMaintenanceProgress task={task} />)
    expect(screen.getByRole('progressbar', { name: '安装包下载进度' })).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '4.0 MiB / 16.0 MiB，下载安装包')
    expect(screen.getByText('平均 512.0 KiB/s')).toBeInTheDocument()
    const steps = screen.getByRole('list', { name: '维护阶段' })
    expect(within(steps).getByRole('listitem', { name: '环境检查：已完成' })).toBeInTheDocument()
    expect(within(steps).getByRole('listitem', { name: '下载安装：进行中' })).toHaveAttribute('aria-current', 'step')
    expect(within(steps).getByRole('listitem', { name: '健康检查：待执行' })).toBeInTheDocument()
  })
  it('传输完成后仍展示校验过程，失败不宣称安装包已就绪', () => {
    const verifying = { ...task, download: { ...task.download!, completedBytes: task.download!.totalBytes, status: 'verifying' as const } }
    const view = render(<PanelMaintenanceProgress task={verifying} />)
    expect(screen.getByText('正在校验安装包')).toBeInTheDocument()
    expect(screen.queryByText('安装包已校验')).not.toBeInTheDocument()
    view.rerender(<PanelMaintenanceProgress task={{ ...verifying, state: 'failed', phase: 'finished', failedPhase: 'downloading-release' }} />)
    expect(screen.getByText('安装包校验失败')).toBeInTheDocument()
    expect(screen.getByText('失败阶段：下载安装包')).toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: '健康检查：待执行' })).toBeInTheDocument()
  })
  it.each([{ workerStatus: 'unknown' as const }, { workerDead: true }, { paused: true }])('进程或连接未确认时冻结活动图形：%j', ({ paused, ...changes }) => {
    const { container } = render(<PanelMaintenanceProgress task={{ ...task, ...changes }} paused={paused} />)
    expect(screen.getByText('等待进度同步')).toBeInTheDocument()
    expect(screen.queryByText(/平均/)).not.toBeInTheDocument()
    expect(container.querySelector('.motion-safe\\:animate-spin')).toBeNull()
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
