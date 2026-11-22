import { PANEL_TASK_PHASE_LABELS, PANEL_UPDATE_SOURCE_LABELS, panelTaskIsActive } from '@elysian/contracts'
import type { PanelTask } from '@elysian/contracts'
import { Check, Download, Loader2 } from '../../components/icons'
import { CopyButton } from '../../components/CopyButton'
import { StepPanels, Stepper, type Step } from '../../components/easyui/Stepper'

type MaintenanceStep = Step & { key: string; phases: string[] }

const updateSteps: MaintenanceStep[] = [
  { key: 'checking', title: '检查运行环境', description: '核对更新目标、端口配置与宿主资源', phases: ['checking'] },
  { key: 'download', title: '下载安装包', description: '获取当前架构对应的版本文件', phases: ['downloading-release'] },
  { key: 'verification', title: '校验安装包', description: '比对 SHA256、发布清单、目标提交与架构', phases: [] },
  { key: 'prepare', title: '准备新版本', description: '暂存已通过校验的程序和资源', phases: ['preparing-resources', 'preparing-release', 'building'] },
  { key: 'restart', title: '切换并重启', description: '备份数据、切换程序与配置并启动', phases: ['firewall', 'stopping', 'activating'] },
  { key: 'health', title: '健康检查', description: '确认目标版本可用并恢复临时停止的业务', phases: ['verifying', 'restoring-resources'] },
]

const sourceUpdateSteps: MaintenanceStep[] = [
  updateSteps[0]!,
  { key: 'download-source', title: '下载源码', description: '获取目标提交的源码', phases: ['downloading'] },
  { key: 'prepare-resources', title: '准备构建资源', description: '按更新计划核对并准备宿主资源', phases: ['preparing-resources'] },
  { key: 'build', title: '构建新版本', description: '编译候选版本后再切换运行程序', phases: ['preparing-release', 'building'] },
  updateSteps[4]!,
  updateSteps[5]!,
]

const configSteps: MaintenanceStep[] = [
  updateSteps[0]!,
  { key: 'firewall', title: '配置访问入口', description: '为面板新地址准备防火墙规则', phases: ['firewall'] },
  { key: 'restart', title: '重启面板', description: '备份数据、应用配置并启动服务', phases: ['stopping', 'activating'] },
  { key: 'health', title: '健康检查', description: '确认面板已在新配置下正常运行', phases: ['verifying', 'restoring-resources'] },
]

const failedStates = ['failed', 'rolled-back', 'recovery-failed']
const sourcePhases = ['downloading', 'preparing-resources', 'preparing-release', 'building', 'firewall', 'stopping', 'activating', 'verifying', 'restoring-resources']

function taskPhase(task: PanelTask): string {
  return failedStates.includes(task.state) ? task.failedPhase ?? task.phase : task.phase
}

function isSourceUpdate(task: PanelTask, phase: string): boolean {
  return task.kind === 'update' && !task.download && sourcePhases.includes(phase)
}

function stepsFor(task: PanelTask, phase: string): MaintenanceStep[] {
  if (task.kind !== 'update') return configSteps
  return isSourceUpdate(task, phase) ? sourceUpdateSteps : updateSteps
}

function currentStep(task: PanelTask, steps: MaintenanceStep[], phase: string): number {
  if (task.state === 'succeeded') return steps.length - 1

  if (task.kind === 'update' && steps === updateSteps && phase === 'downloading-release') {
    if (task.download?.status === 'verifying') return 2
    if (task.download?.status === 'ready') return 3
    return 1
  }

  return steps.findIndex(step => step.phases.includes(phase))
}

export function panelMaintenancePhaseLabel(task: PanelTask): string {
  const phase = taskPhase(task)
  if (task.kind === 'update' && phase === 'downloading-release') {
    if (task.download?.status === 'verifying') return '校验安装包'
    if (task.download?.status === 'ready') return '准备新版本'
    return '下载安装包'
  }
  if (task.kind === 'update' && phase === 'preparing-release') return '准备新版本'
  if (task.kind === 'update' && phase === 'preparing-resources') return '准备更新资源'
  return PANEL_TASK_PHASE_LABELS[phase] ?? phase
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 ** 2).toFixed(1)} MiB`
}

function stepDetail(task: PanelTask, step: MaintenanceStep, phase: string, moving: boolean): string {
  if (task.state === 'succeeded') return '维护任务已完成，所有已记录阶段均已结束。'
  if (failedStates.includes(task.state)) return '此阶段未能完成。具体原因见维护任务错误信息和日志。'
  if (task.state === 'queued') return '维护任务已排队，开始执行后会先检查当前环境。'
  if (!moving) return '服务器尚未确认新的阶段回执，当前显示停留在最后一条已确认进度。'

  switch (step.key) {
    case 'checking':
      return '正在核对当前端口配置、目标版本和服务器资源。'
    case 'download':
      if (task.download?.status === 'verifying') return '下载字节已接收完成，服务器正在进入安装包校验。'
      if (task.download?.status === 'ready') return '安装包校验已完成，正在准备更新资源和候选版本。'
      return task.download ? '正在接收安装包，下面的百分比和速率来自实际下载字节。' : '正在查询目标发布并准备安装包下载。'
    case 'download-source':
      return '正在获取目标提交的源码。'
    case 'verification':
      return '文件已全部接收，服务器正在比对发布包 SHA256、目标提交、文件摘要和可执行文件架构。'
    case 'prepare':
      if (phase === 'preparing-resources') return '正在核对本次更新计划中的资源，需要释放时只处理计划列出的对象。'
      if (phase === 'building') return '正在构建新版本，构建完成后才会切换当前运行程序。'
      if (phase === 'downloading-release' && task.download?.status === 'ready') return '安装包校验结果已返回通过，正在准备更新资源。'
      return '安装包校验已返回通过，正在把新版本文件暂存到独立版本目录。'
    case 'prepare-resources':
      return '正在核对更新前确认的资源身份，并按更新计划准备构建所需资源。'
    case 'build':
      return '正在编译候选版本，完成后才会配置入口并重启面板。'
    case 'restart':
      if (phase === 'firewall') return '正在准备新访问入口，当前版本仍在运行。'
      if (phase === 'stopping') return '正在停止面板并备份持久化数据，随后会切换候选版本。'
      return '正在应用端口配置、切换程序版本并启动面板。'
    case 'firewall':
      return '正在为面板新地址准备访问规则。'
    case 'health':
      if (phase === 'restoring-resources') return '新版本健康检查已通过，正在恢复本次更新临时停止的业务。'
      return '面板已重新启动，正在确认目标提交和服务健康状态。'
    default:
      return '正在执行维护任务当前阶段。'
  }
}

export function PanelMaintenanceProgress({ task, paused = false }: { task: PanelTask; paused?: boolean }) {
  const phase = taskPhase(task)
  const steps = stepsFor(task, phase)
  const failed = failedStates.includes(task.state)
  const current = currentStep(task, steps, phase)
  const moving = task.state === 'running' && task.workerStatus === 'alive' && !task.workerDead && !paused
  const download = task.download
  const percent = download ? Math.max(0, Math.min(100, Math.floor(download.completedBytes / download.totalBytes * 100))) : 0
  const downloading = task.phase === 'downloading-release' && panelTaskIsActive(task)
  const downloadLabel = failed && download?.status !== 'ready'
    ? download?.status === 'verifying' ? '安装包校验未完成' : '下载未完成'
    : download?.status === 'ready' ? '安装包已校验'
      : download?.status === 'verifying' ? '正在校验安装包' : '下载安装包'
  const validTaskStages = current >= 0 && current < steps.length

  return <div className="mt-4 space-y-4">
    {task.kind === 'update' ? <div className="grid min-w-0 gap-2 rounded-xl bg-surface-raised/60 p-3 text-xs leading-5 sm:grid-cols-2">
      <p className="text-fg-muted">更新来源：{task.updateSource ? PANEL_UPDATE_SOURCE_LABELS[task.updateSource] : '未记录（历史任务）'}</p>
      <p className="text-fg-muted">版本：{task.releaseTag ? <span className="font-medium text-fg">{task.releaseTag}</span> : '历史更新'}</p>
      <div className="flex min-w-0 items-center gap-2 sm:col-span-2"><span className="shrink-0 text-fg-muted">目标提交</span><code className="min-w-0 truncate text-fg" title={task.targetCommit}>{task.targetCommit || '未记录'}</code>{task.targetCommit ? <CopyButton label="提交" tooltip="复制完整提交 SHA" value={task.targetCommit} /> : null}</div>
    </div> : null}

    {validTaskStages ? <>
      <Stepper
        ariaLabel="维护阶段"
        steps={steps}
        current={current}
        completed={task.state === 'succeeded'}
        failed={failed}
      />
      <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
        <StepPanels current={current}>
          {steps.map(step => <p key={step.key} className="text-xs leading-5 text-fg-muted">{stepDetail(task, step, phase, moving)}</p>)}
        </StepPanels>
      </div>
    </> : task.state !== 'succeeded' && !panelTaskIsActive(task)
      ? <p className="text-xs text-fg-muted">历史任务未记录结束前的阶段。</p>
      : null}

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

    {task.kind === 'update' && download?.status === 'ready' ? <section aria-label="安装包校验结果" className="rounded-lg border border-success/30 bg-success/5 p-3">
      <h3 className="flex items-center gap-2 text-xs font-medium text-fg"><Check size={14} className="text-success" aria-hidden />安装包校验通过</h3>
      <ul className="mt-2 grid gap-x-4 gap-y-1 text-[0.6875rem] leading-5 text-fg-muted sm:grid-cols-2">
        <li>发布包 SHA256 与发布信息一致</li>
        <li>目标提交与 release.json 一致</li>
        <li>发布清单中的文件摘要已核对</li>
        <li>可执行文件架构与当前主机一致</li>
      </ul>
    </section> : null}
  </div>
}
