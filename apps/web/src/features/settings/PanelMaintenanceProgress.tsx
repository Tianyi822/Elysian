import { PANEL_TASK_PHASE_LABELS, PANEL_UPDATE_SOURCE_LABELS, panelTaskIsActive } from '@elysian/contracts'
import type { PanelTask } from '@elysian/contracts'
import { Check, Download, Loader2, X } from '../../components/icons'
import { CopyButton } from '../../components/CopyButton'

const updateSteps = [
  { label: '环境检查', phases: ['checking'] },
  { label: '下载安装', phases: ['downloading-release', 'downloading'] },
  { label: '校验准备', phases: ['preparing-release', 'preparing-resources', 'building'] },
  { label: '切换版本', phases: ['firewall', 'stopping', 'activating'] },
  { label: '健康检查', phases: ['verifying', 'restoring-resources'] },
]
const configSteps = [updateSteps[0]!, { label: '准备配置', phases: ['firewall'] }, { label: '重启面板', phases: ['stopping', 'activating'] }, updateSteps[4]!]

function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 ** 2).toFixed(1)} MiB`
}

export function PanelMaintenanceProgress({ task, paused = false }: { task: PanelTask; paused?: boolean }) {
  const steps = task.kind === 'update' ? updateSteps : configSteps
  const failed = ['failed', 'rolled-back', 'recovery-failed'].includes(task.state)
  const phase = failed ? task.failedPhase ?? task.phase : task.phase
  const current = steps.findIndex(step => step.phases.includes(phase))
  const moving = task.state === 'running' && task.workerStatus === 'alive' && !task.workerDead && !paused
  const download = task.download
  const percent = download ? Math.floor(download.completedBytes / download.totalBytes * 100) : 0
  const downloading = task.phase === 'downloading-release' && panelTaskIsActive(task)
  const downloadLabel = failed && download?.status !== 'ready' ? download?.status === 'verifying' ? '安装包校验失败' : '下载未完成' : download?.status === 'ready' ? '安装包已校验' : download?.status === 'verifying' ? '正在校验安装包' : '下载安装包'

  return <div className="mt-4 space-y-4">
    {task.kind === 'update' ? <div className="grid min-w-0 gap-2 rounded-xl bg-surface-raised/60 p-3 text-xs leading-5 sm:grid-cols-2">
      <p className="text-fg-muted">更新来源：{task.updateSource ? PANEL_UPDATE_SOURCE_LABELS[task.updateSource] : '未记录（历史任务）'}</p>
      <p className="text-fg-muted">版本：{task.releaseTag ? <span className="font-medium text-fg">{task.releaseTag}</span> : '历史更新'}</p>
      <div className="flex min-w-0 items-center gap-2 sm:col-span-2"><span className="shrink-0 text-fg-muted">目标提交</span><code className="min-w-0 truncate text-fg" title={task.targetCommit}>{task.targetCommit || '未记录'}</code>{task.targetCommit ? <CopyButton label="提交" tooltip="复制完整提交 SHA" value={task.targetCommit} /> : null}</div>
    </div> : null}
    {current < 0 && task.state !== 'succeeded' && !panelTaskIsActive(task) ? <p className="text-xs text-fg-muted">历史任务未记录结束前的阶段。</p> : <ol aria-label="维护阶段" className="flex">
      {steps.map((step, index) => {
        const done = task.state === 'succeeded' || current >= 0 && index < current
        const selected = index === current
        const status = done ? '已完成' : selected ? failed ? '失败' : task.state === 'queued' ? '等待执行' : paused || task.workerStatus !== 'alive' || task.workerDead ? '等待确认' : '进行中' : '待执行'
        return <li key={step.label} aria-label={`${step.label}：${status}`} aria-current={selected && panelTaskIsActive(task) ? 'step' : undefined} className="relative flex min-w-0 flex-1 flex-col items-center gap-2 text-center">
          {index > 0 ? <span aria-hidden className={`absolute top-3.5 right-1/2 h-px w-full ${done || selected ? 'bg-accent/40' : 'bg-line'}`} /> : null}
          <span aria-hidden className={`relative flex size-7 items-center justify-center rounded-full border text-xs tabular-nums ${selected && failed ? 'border-danger/40 bg-surface text-danger' : done ? 'border-accent/30 bg-surface text-accent-fg' : selected ? 'border-accent bg-surface text-accent-fg' : 'border-line bg-surface text-fg-subtle'}`}>
            {done ? <Check size={14} /> : selected && failed ? <X size={14} /> : selected && moving ? <Loader2 size={14} className="motion-safe:animate-spin" /> : index + 1}
          </span>
          <span className={`text-[0.6875rem] leading-4 sm:text-xs ${done || selected ? 'text-fg' : 'text-fg-subtle'}`}>{step.label}</span>
        </li>
      })}
    </ol>}
    {download ? <div className="rounded-xl border border-line p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-2 font-medium text-fg"><Download size={14} aria-hidden />{downloadLabel}</span>
        <span className="font-mono tabular-nums text-fg">{percent}%</span>
      </div>
      <div role="progressbar" aria-label="安装包下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${bytes(download.completedBytes)} / ${bytes(download.totalBytes)}，${downloadLabel}`} className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-raised">
        <div style={{ width: `${percent}%` }} className={`h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500 ${failed && download.status !== 'ready' ? 'bg-danger' : 'bg-accent'}`} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[0.6875rem] tabular-nums text-fg-muted">
        <span>{bytes(download.completedBytes)} <span className="text-fg-subtle">/</span> {bytes(download.totalBytes)}</span>
        {downloading && download.status === 'downloading' && moving && download.bytesPerSecond > 0 ? <span>平均 {bytes(download.bytesPerSecond)}/s</span> : null}
        {downloading && !moving ? <span>等待进度同步</span> : null}
      </div>
      <p className="mt-2 truncate font-mono text-[0.625rem] text-fg-subtle" title={download.fileName}>{download.fileName}</p>
    </div> : downloading ? <p className="flex items-center gap-2 text-xs text-fg-muted">{moving ? <Loader2 size={14} aria-hidden className="motion-safe:animate-spin" /> : <Download size={14} aria-hidden />}正在获取安装包信息，等待下载数据…</p> : null}
    {failed && task.failedPhase ? <p className="text-xs text-danger">失败阶段：{PANEL_TASK_PHASE_LABELS[task.failedPhase] ?? task.failedPhase}</p> : null}
  </div>
}
