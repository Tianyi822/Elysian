import { CONTAINER_BUILD_STATE_LABELS, isContainerBuildActive, type ContainerBuildTask } from '@elysian/contracts'
import { Button } from '../../components/Button'
import { CTL_DANGER, CTL_SECONDARY } from '../../components/formControl'
import { formatDateTime } from '../../components/format'
import { IconButton } from '../../components/IconButton'
import { CircleCheck, Loader2, RotateCw, ScrollText, Square, Timer, TriangleAlert } from '../../components/icons'
import { CopyPathButton } from './CopyPathButton'

/** 状态一律「文字 + 颜色 + 图标」：颜色只作辅助，语义由文字承担。 */
function BuildStateBadge({ state }: { state: ContainerBuildTask['state'] }) {
  const label = CONTAINER_BUILD_STATE_LABELS[state]
  if (state === 'queued') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
        <Timer aria-hidden size={12} />
        {label}
      </span>
    )
  }
  if (state === 'building') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
        <Loader2 aria-hidden size={12} className="animate-spin motion-reduce:animate-none" />
        {label}
      </span>
    )
  }
  if (state === 'succeeded') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-success">
        <CircleCheck aria-hidden size={12} />
        {label}
      </span>
    )
  }
  if (state === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-danger">
        <TriangleAlert aria-hidden size={12} />
        {label}
      </span>
    )
  }
  if (state === 'cancelled') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-fg-subtle">
        <Square aria-hidden size={12} />
        {label}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-warning">
      <TriangleAlert aria-hidden size={12} />
      {label}
    </span>
  )
}

/** 任务行的目标摘要：dockerfile 用目标名，compose 用提交的服务清单（缺省全部 build 服务）。 */
export function buildTargetsLabel(task: ContainerBuildTask): string {
  if (task.mode === 'dockerfile') return task.input.mode === 'dockerfile' ? task.input.target ?? 'app' : 'app'
  return task.input.mode === 'compose' && task.input.services?.length ? task.input.services.join('、') : '全部 build 服务'
}

export function BuildTaskList({ workspaceName, tasks, onLogs, onCancel, onRebuild }: {
  workspaceName: string
  tasks: readonly ContainerBuildTask[]
  onLogs: (id: string) => void
  onCancel: (task: ContainerBuildTask) => void
  onRebuild: (task: ContainerBuildTask) => void
}) {
  return (
    <ul className="space-y-2" aria-label={`${workspaceName} 的构建任务列表`}>
      {tasks.map((task) => {
        const active = isContainerBuildActive(task.state)
        return (
          <li key={task.id} className="rounded-lg border border-line bg-surface-raised/50 px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 flex-1 truncate text-xs text-fg">
                <span className="font-mono">{buildTargetsLabel(task)}</span>
                <span className="ml-1.5 text-fg-subtle">
                  {task.mode === 'dockerfile' ? 'Dockerfile' : 'compose'}
                </span>
              </span>
              <BuildStateBadge state={task.state} />
              <span className="shrink-0 text-xs tabular-nums text-fg-subtle" title={`提交于 ${task.createdAt}`}>
                {formatDateTime(task.createdAt)}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <IconButton
                  label="查看构建日志"
                  variant="ghost"
                  onPress={() => onLogs(task.id)}
                >
                  <ScrollText aria-hidden size={13} />
                </IconButton>
                {active ? (
                  <Button variant="destructive"
                    type="button"
                    onClick={() => onCancel(task)}
                    className={`${CTL_DANGER} px-2 text-xs`}
                  >
                    取消
                  </Button>
                ) : (
                  <Button variant="outline"
                    type="button"
                    onClick={() => onRebuild(task)}
                    className={`${CTL_SECONDARY} gap-1 px-2 text-xs`}
                  >
                    <RotateCw aria-hidden size={12} />
                    重新构建
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-1 text-xs text-fg-muted">{task.stage}</p>
            {task.state === 'failed' && task.error ? (
              <p role="alert" className="mt-1 break-all text-xs text-danger">
                {task.error}
              </p>
            ) : null}
            {task.state === 'succeeded' && task.results.length > 0 ? (
              <p className="mt-1 text-xs text-fg-subtle">
                面板不编排，请在宿主自行拉起（compose up 或 docker run）。
              </p>
            ) : null}
            {task.results.length > 0 ? (
              <ul className="mt-1.5 space-y-1">
                {task.results.map((result) => (
                  <li key={`${result.target}:${result.tag}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {result.state === 'succeeded' ? (
                      <>
                        <code className="min-w-0 flex-1 break-all font-mono text-xs text-fg">
                          {result.repository}:{result.tag}
                        </code>
                        <span className="shrink-0 text-xs text-fg-subtle">{result.target}</span>
                        <CopyPathButton
                          value={`${result.repository}:${result.tag}`}
                          label="完整镜像标签"
                        />
                      </>
                    ) : (
                      <p className="min-w-0 flex-1 break-all text-xs text-danger">
                        {result.target}：{result.error}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
