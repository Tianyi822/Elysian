import type { AgentRuntimeInfo, RuntimeRun } from '@elysian/contracts'
import { runtimeRunIsActive } from '@elysian/contracts'

/*
 * 运行记录页的纯展示辅助：标签表、字节与时长格式化、能力位命名。
 * 全部为纯函数，不读 store、不发请求；时间格式化复用 components/format。
 */

/** Run 的八个 phase；checkpoint 与 final-memory 统一呈现为「整理中」，不造新状态。 */
export const RUN_PHASE_LABELS = {
  queued: '排队中',
  inference: '推理中',
  checkpoint: '整理中',
  'final-memory': '整理中',
  'workflow-output': '提交工作流输出',
  'waiting-approval': '等待审批',
  'waiting-resource': '等待资源',
  completed: '已完成',
} as const

export function isMemoryPhase(phase: string | undefined): boolean {
  return phase === 'checkpoint' || phase === 'final-memory'
}

export const RUN_KIND_LABELS = {
  'tool-batch': '批次',
  agent: 'Agent',
  workflow: '工作流',
} as const

/** Run 的 kind：优先 task.kind，退回 driver 的场景推断（无 task 时按 workflowId 判断）。 */
export function runKindOf(run: RuntimeRun): keyof typeof RUN_KIND_LABELS {
  if (run.task !== undefined) return run.task.kind
  if (run.workflowId !== undefined) return 'workflow'
  if (run.driverVersion === 'v2' || run.sessionId !== undefined) return 'agent'
  return 'tool-batch'
}

export function driverLabel(run: RuntimeRun): string {
  if (run.driverVersion !== undefined) return run.driverVersion
  return '—'
}

/** 12 个能力位的界面命名（与 /runtime 报告一一对应）。 */
export const RUNTIME_CAPABILITY_LABELS = {
  batch: '批次通道',
  agent: 'Agent 会话',
  skills: '技能',
  mcp: 'MCP',
  containerExecution: '容器执行',
  approvals: '审批',
  workflow: '工作流（v1）',
  wiki: '长期记忆',
  embedding: '向量索引',
  workflowV2: '工作流（v2）',
  resourceLocks: '资源锁',
  executionRuntimes: '执行器运行时',
} as const

export type RuntimeCapabilityKey = keyof typeof RUNTIME_CAPABILITY_LABELS

/** 报告卡展示的能力位次序（与契约 AGENT_RUNTIME_CAPABILITY_KEYS 同序）。 */
export const RUNTIME_CAPABILITY_ORDER: readonly RuntimeCapabilityKey[] = [
  'batch', 'agent', 'skills', 'mcp', 'containerExecution', 'approvals',
  'workflow', 'wiki', 'embedding', 'workflowV2', 'resourceLocks', 'executionRuntimes',
]

export function capabilityRows(info: AgentRuntimeInfo): readonly { key: RuntimeCapabilityKey; label: string; available: boolean; reason?: string }[] {
  return RUNTIME_CAPABILITY_ORDER.map((key) => ({
    key,
    label: RUNTIME_CAPABILITY_LABELS[key],
    available: info[key].available,
    ...(info[key].reason === undefined ? {} : { reason: info[key].reason }),
  }))
}

/** 字节数的紧凑读数（2 MiB / 512 KiB / 96 B）；未知量不进此函数。 */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`
}

/** 活动执行时长（activeMilliseconds）：3 分 5 秒 / 40 秒；未知为 —。 */
export function formatActiveDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return '—'
  const totalSeconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds} 秒`
  return `${minutes} 分 ${seconds} 秒`
}

/** 终态判定：cancelled/failed/succeeded/interrupted 之后不再轮询、取消按钮禁用。 */
export function runIsTerminal(run: RuntimeRun | undefined): boolean {
  return run === undefined || !runtimeRunIsActive(run.status)
}

/** 「已请求取消」：cancelRequestedAt 非空且未到终态——与「已取消」严格分开。 */
export function runCancelRequested(run: RuntimeRun): boolean {
  return run.cancelRequestedAt !== undefined && !runIsTerminal(run)
}

/** interrupted 的原因文案：endReason + error.message；页面另附「不自动重跑」说明行。 */
export function interruptedReasonText(run: RuntimeRun): string {
  const code = run.endReason ?? run.error?.code ?? 'unknown'
  const detail = run.error?.message ?? '运行被中断，原因未随记录下发'
  return `${code}：${detail}`
}

export function usageUnknown(value: number | undefined): string {
  return value === undefined ? '未知' : String(value)
}
