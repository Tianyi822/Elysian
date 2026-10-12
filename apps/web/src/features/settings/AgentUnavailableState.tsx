import { TriangleAlert } from '../../components/icons'

/** 模型设置的内核不可用状态；以服务端 reason 为准，恢复后轮询回读。 */
export function AgentUnavailableState({
  reason,
  worker,
  storage,
}: {
  /** 服务端中文原因；缺失时显示通用说明。 */
  reason?: string
  /** /runtime.worker（如 ready）。 */
  worker?: string
  /** /runtime.storage（如 ready / degraded）。 */
  storage?: string
}) {
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-1.5 panel-surface p-6 text-center"
    >
      <TriangleAlert aria-hidden size={20} className="text-warning" />
      <p className="text-sm font-medium">Agent 内核不可用</p>
      <p className="max-w-prose text-xs text-fg-muted">
        {reason?.trim() ? reason : 'Ely 任务运行内核当前不可用。连接恢复后会自动回读状态，此期间模型配置暂不可用。'}
      </p>
      {worker !== undefined || storage !== undefined ? (
        <p className="max-w-prose text-xs text-fg-subtle">
          {[
            worker !== undefined ? `Worker：${worker}` : null,
            storage !== undefined ? `存储：${storage}` : null,
          ].filter((part): part is string => part !== null).join(' · ')}
        </p>
      ) : null}
    </div>
  )
}
