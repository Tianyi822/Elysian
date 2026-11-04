import type { AgentTaskProgress } from '@elysian/contracts'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

export function ChatToolProgress({ tool, progress, unknown }: { tool: string; progress?: AgentTaskProgress; unknown: boolean }) {
  const current = progress?.currentBytes, total = progress?.totalBytes
  const percent = !unknown && progress?.layerId && current !== undefined && total !== undefined && total > 0
    ? Math.min(100, Math.floor(current / total * 100)) : undefined
  const message = progress?.message || (unknown ? '任务结果未确认，须核实实际状态' : '正在执行后台任务')
  return <div className="chat-tool-progress">
    <div className="chat-tool-progress-label" role="status">
      <span>{message}{!unknown && progress?.layerId ? ` · 当前层 ${progress.layerId.slice(0, 12)}` : ''}</span>
      {percent !== undefined && <span className="chat-tool-progress-bytes">{formatBytes(current!)} / {formatBytes(total!)} · {percent}%</span>}
    </div>
    {!unknown && <div className="chat-tool-progress-track" role="progressbar"
      aria-label={`${tool} ${progress?.layerId ? '当前镜像层进度' : '任务进度'}`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={message}>
      <span key={progress?.layerId ?? 'task'} className={percent === undefined ? 'chat-tool-progress-indeterminate' : undefined}
        style={percent === undefined ? undefined : { width: `${percent}%` }} />
    </div>}
  </div>
}
