import type {
  AgentWorkflowBinding,
  AgentWorkflowInstance,
  AgentWorkflowNodeExecution,
  AgentWorkflowScope,
  AgentWorkflowStepDefinition,
} from '@elysian/contracts'
import { AGENT_WORKFLOW_STEP_KIND_LABELS } from '@elysian/contracts'

/*
 * 工作流页面的纯展示工具：字节/时长格式化、绑定五选一标注、用量五维行、
 * v1 单链步骤视图与 join 命名空间说明。不触碰 adapter 与 store。
 */

export function formatWorkflowBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

export function formatWorkflowDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

/** 绑定五选一中文标注：值来源互斥，原文（literalJson 等）不在标注里重排。 */
export function describeWorkflowBinding(binding: AgentWorkflowBinding | undefined): string {
  if (binding === undefined) return '—'
  if (binding.literalJson !== undefined) return `字面量 ${binding.literalJson}`
  if (binding.input !== undefined) return `输入 ${binding.input === '' ? '（整体）' : binding.input}`
  if (binding.step !== undefined) return `步骤 ${binding.step.stepId} → ${binding.step.pointer === '' ? '（整体）' : binding.step.pointer}`
  if (binding.object !== undefined) {
    const entries = Object.entries(binding.object)
    return entries.length === 0 ? '对象 {}（空）' : `对象 { ${entries.map(([key, child]) => `${key}: ${describeWorkflowBinding(child)}`).join(', ')} }`
  }
  if (binding.array !== undefined) {
    return binding.array.length === 0 ? '数组 []（空）' : `数组 [ ${binding.array.map((child) => describeWorkflowBinding(child)).join(', ')} ]`
  }
  return '—'
}

export type WorkflowUsageRow = {
  key: string
  label: string
  usedText: string
  limitText: string
  ratio: number
}

function ratioText(used: number, limit: number, format: (value: number) => string): WorkflowUsageRow {
  const safeLimit = limit > 0 ? limit : 1
  return {
    key: '',
    label: '',
    usedText: format(used),
    limitText: format(limit),
    ratio: Math.max(0, Math.min(1, used / safeLimit)),
  }
}

/** 实例预算五维：活动时间（含预留）/模型请求/工具调用/token/结果字节。 */
export function workflowUsageRows(instance: AgentWorkflowInstance): readonly WorkflowUsageRow[] {
  const rows: WorkflowUsageRow[] = [
    { ...ratioText(instance.usage.activeMilliseconds + instance.usage.reservedMilliseconds, instance.limits.activeMilliseconds, formatWorkflowDuration), key: 'activeMilliseconds', label: '活动执行时间（含预留）' },
    { ...ratioText(instance.usage.modelRequests, instance.limits.modelRequests, String), key: 'modelRequests', label: '模型请求' },
    { ...ratioText(instance.usage.calls, instance.limits.calls, String), key: 'calls', label: '工具调用' },
    { ...ratioText(instance.usage.tokens, instance.limits.tokens, String), key: 'tokens', label: 'Token 预算' },
    { ...ratioText(instance.usage.resultBytes, instance.limits.resultBytes, formatWorkflowBytes), key: 'resultBytes', label: '结果字节' },
  ]
  return rows
}

/** v2 join 命名空间：parallel/foreach 子工作区按 .workflow/<nodeId>/<ordinal>/ 汇入父工作区。 */
export const WORKFLOW_JOIN_NAMESPACE_NOTE =
  'parallel 与 foreach 的子分支各有私有 Task 工作区；汇合时子分支相对父版本的新增文件会按 .workflow/<nodeId>/<ordinal>/ 前缀并入父工作区（scope_runtime.go 的 join 语义）。'

/** 兄弟分支失败后的推进语义说明（常驻）。 */
export const WORKFLOW_SIBLING_FREEZE_NOTE =
  '分支内某节点进入等待人工恢复后，同批其余分支即使已成功也不再推进，join 会一直等待人工处置；已成功的分支不回滚。'

export type WorkflowTreeNodeRow = {
  node: AgentWorkflowNodeExecution
  scope: AgentWorkflowScope
  step?: AgentWorkflowStepDefinition
}

/** 作用域的直接节点按 ordinal 排序；步骤定义按 stepId 从 body 查回。 */
export function scopeNodeRows(scope: AgentWorkflowScope, nodes: readonly AgentWorkflowNodeExecution[]): readonly WorkflowTreeNodeRow[] {
  return nodes
    .filter((node) => node.scopeId === scope.id)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((node) => ({ node, scope, step: scope.body.steps.find((step) => step.id === node.stepId) }))
}

/** 子作用域按 parentNodeId 分组、ordinal 排序（parallel 分支与 foreach 项按序号展开）。 */
export function childScopeGroups(
  parentNodeId: string,
  scopes: readonly AgentWorkflowScope[],
): readonly AgentWorkflowScope[] {
  return scopes.filter((scope) => scope.parentNodeId === parentNodeId).sort((a, b) => a.ordinal - b.ordinal)
}

export function workflowStepKindLabel(kind: string): string {
  return AGENT_WORKFLOW_STEP_KIND_LABELS[kind as keyof typeof AGENT_WORKFLOW_STEP_KIND_LABELS] ?? kind
}

/** 尝试次数上限说明：attempt ≤ limits.attempts（默认 3）。 */
export function attemptLimitText(node: AgentWorkflowNodeExecution, limits: AgentWorkflowInstance['limits']): string {
  return `${node.attempt} / ${limits.attempts}`
}
