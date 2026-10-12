import type { RuntimeMemoryStatus, RuntimeRun, RuntimeUsage } from '@elysian/contracts'

/*
 * 工作台内的展示辅助：字节量、用量行与「整理中/已请求取消」的派生口径。
 * 「整理中」不是独立状态：Run running 且 phase 为 checkpoint/final-memory。
 * 用量缺省即未知（显示「未报告」），绝不补零。
 */

export function formatWorkbenchBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

/** Run 是否仍在整理（服务端 phase 为 checkpoint/final-memory 且未终态）。 */
export function isConsolidating(run: RuntimeRun | undefined): boolean {
  return run !== undefined && run.status === 'running' && (run.phase === 'checkpoint' || run.phase === 'final-memory')
}

/** 取消请求已落盘但运行未终态：界面必须与「已取消」严格分开。 */
export function isCancelRequested(run: RuntimeRun | undefined): boolean {
  return run !== undefined && run.cancelRequestedAt !== undefined && !isTerminalRun(run)
}

export function isTerminalRun(run: RuntimeRun | undefined): boolean {
  if (run === undefined) return false
  return run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted'
}

export const MEMORY_STATUS_LABELS: Record<RuntimeMemoryStatus, string> = {
  unchanged: '未变化',
  updated: '已更新',
  stale: '未整理',
  invalidated: '已失效',
}

export type UsageRow = { label: string; value: string; hint?: string }

/** usage 的未知字段显示「未报告」，估算与供应商报告分行标注。 */
export function usageRows(usage: RuntimeUsage | undefined): UsageRow[] {
  if (usage === undefined) return []
  const rows: UsageRow[] = [
    { label: '工具调用', value: String(usage.calls) },
    { label: '结果体积', value: formatWorkbenchBytes(usage.resultBytes) },
    { label: '模型请求', value: usage.modelRequests === undefined ? '未报告' : String(usage.modelRequests) },
    { label: '估算 token', value: usage.estimatedTokens === undefined ? '未报告' : String(usage.estimatedTokens), hint: '面板按上下文长度估算' },
    { label: '供应商报告 token', value: usage.actualTokens === undefined ? '未报告' : String(usage.actualTokens), hint: '缺少报告时保持未知，不计为零' },
    { label: '缓存命中 token', value: usage.cachedTokens === undefined ? '未报告' : String(usage.cachedTokens) },
  ]
  return rows
}

export const PHASE_LABELS: Record<NonNullable<RuntimeRun['phase']>, string> = {
  queued: '排队中',
  inference: '推理中',
  checkpoint: '整理中（检查点）',
  'final-memory': '整理中（收尾记忆）',
  'workflow-output': '工作流输出',
  'waiting-approval': '等待审批',
  'waiting-resource': '等待资源',
  completed: '已完成',
}
