import { TriangleAlert } from '../icons'

/*
 * 六态之「内核不可用」。触发条件：/runtime 明示 available:false，或 Agent 端点
 * 返回内核级 503（扩展/MCP/执行器等分项故障由对应页面显示）。
 * reason 是服务端中文说明（权威），worker 与 storage 是
 * /runtime 的补充诊断位；本状态不是普通错误——不提供盲目重试，恢复由服务端侧
 * 完成后轮询自然回到就绪。
 */
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
        {reason?.trim() ? reason : 'Ely 任务运行内核当前不可用。连接恢复后会自动回读状态，此期间不接受新的任务派发。'}
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
