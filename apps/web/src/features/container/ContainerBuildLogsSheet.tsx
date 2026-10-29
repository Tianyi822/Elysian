import * as Dialog from '@radix-ui/react-dialog'
import { useEffect } from 'react'
import { Loader2, ScrollText, TriangleAlert, X } from '../../components/icons'
import { CONTAINER_BUILD_STATE_LABELS, isContainerBuildActive } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { IconButton } from '../../components/IconButton'
import { CTL_SECONDARY } from '../../components/formControl'
import { useContainerAppsStore } from '../../stores/containerAppsStore'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'

/**
 * 构建日志抽屉：打开即从 0 拉全量；任务仍活跃时每 2 秒按已读字节增量续读。
 * 样式与文件编辑抽屉同款（右侧全高），日志行用等宽字体；截断提示行原样显示。
 */
export function ContainerBuildLogsSheet({
  slug,
  taskId,
  onClose,
}: {
  slug: string
  taskId: string
  onClose: () => void
}) {
  const gateway = useGateway()
  const openBuildLogs = useContainerAppsStore((s) => s.openBuildLogs)
  const loadBuildLogs = useContainerAppsStore((s) => s.loadBuildLogs)
  const closeBuildLogs = useContainerAppsStore((s) => s.closeBuildLogs)
  const logs = useContainerAppsStore((s) => s.buildLogs[taskId])
  const task = useContainerAppsStore((s) => s.buildsBySlug[slug]?.find((row) => row.id === taskId))
  useFeedbackMessage(logs?.error)

  useEffect(() => {
    void openBuildLogs(gateway, slug, taskId)
  }, [gateway, slug, taskId, openBuildLogs])

  const active = task !== undefined && isContainerBuildActive(task.state)
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => void loadBuildLogs(gateway, slug, taskId), 2000)
    return () => window.clearInterval(timer)
  }, [gateway, slug, taskId, active, loadBuildLogs])

  const requestClose = () => {
    closeBuildLogs(taskId)
    onClose()
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) requestClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[58] bg-overlay" />
        <Dialog.Content
          aria-describedby="build-logs-description"
          className="fixed inset-y-0 right-0 z-[59] flex w-full max-w-2xl flex-col panel-surface rounded-none shadow-xl"
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <Dialog.Title className="flex items-center gap-1.5 truncate text-sm font-medium">
                <ScrollText aria-hidden size={14} />
                构建日志 · <span className="font-mono">{taskId.slice(0, 8)}</span>
              </Dialog.Title>
              <p id="build-logs-description" className="mt-1 text-xs text-fg-muted">
                {task
                  ? `状态：${CONTAINER_BUILD_STATE_LABELS[task.state]} · ${task.stage}`
                  : '任务清单里已没有这条任务，显示的是最后一次读到的日志。'}
                {active ? '，每 2 秒自动续读。' : ''}
              </p>
            </div>
            <IconButton label="关闭构建日志" variant="ghost" onPress={requestClose}>
              <X aria-hidden size={15} />
            </IconButton>
          </div>

          <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
            {!logs ? (
              <p role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-fg-muted">
                <Loader2 aria-hidden size={15} className="animate-spin" />
                正在读取构建日志…
              </p>
            ) : logs.error ? (
              <div role="alert" className="flex flex-col items-center gap-2 py-10 text-center">
                <TriangleAlert aria-hidden size={18} className="text-danger" />
                <p className="text-sm text-fg">{logs.error}</p>
                <button
                  type="button"
                  onClick={() => void openBuildLogs(gateway, slug, taskId)}
                  className={`${CTL_SECONDARY} px-2`}
                >
                  重试
                </button>
              </div>
            ) : logs.lines.length === 0 ? (
              <p className="py-10 text-center text-sm text-fg-muted">还没有日志输出。</p>
            ) : (
              <ol className="min-h-0 flex-1 space-y-0.5 overflow-y-auto font-mono text-xs text-fg">
                {logs.lines.map((line, index) => (
                  <li
                    key={index}
                    className={`whitespace-pre-wrap break-all ${line.includes('已截断') ? 'text-warning' : ''}`}
                  >
                    {line}
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
            <p className="text-xs text-fg-subtle tabular-nums">
              {logs ? `已读取 ${logs.next} / ${logs.total} 字节` : ''}
            </p>
            <button type="button" onClick={requestClose} className={`${CTL_SECONDARY} px-3`}>
              关闭
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
