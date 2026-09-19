import type { RiskLevel } from './enums.ts'

/**
 * 职责模块：中性的职责名词单元。每个模块都有明确的输入、输出、工具范围与风险上限，
 * 且都不是可以绕过统一策略的独立权限主体。
 *
 * 原起点提示词定义了 13 个模块，2026-09-13 按职责轴归并为 5 个（映射见各条目说明），
 * 决策见 docs/adr/0008-module-consolidation.md。
 */
export type ResponsibilityModule = {
  id: string
  name: string
  purpose: string
  /** 归并前的前提模块名，供术语追溯。 */
  mergedFrom: readonly string[]
  inputs: readonly string[]
  outputs: readonly string[]
  toolScope: readonly string[]
  /** 风险上限：该模块允许提出的动作最高风险等级，超过即必须转人工。 */
  riskCeiling: RiskLevel
}

export const RESPONSIBILITY_MODULES: readonly ResponsibilityModule[] = [
  {
    id: 'command-coordination',
    name: '指挥协调',
    purpose: '总协调、事故指挥与处置决策',
    mergedFrom: ['协调中心', '事故指挥'],
    inputs: ['用户指令', '事故详情', '各模块判断'],
    outputs: ['派发任务', '处置计划', '进展说明'],
    toolScope: ['只读查询', '动作提案'],
    riskCeiling: 'high',
  },
  {
    id: 'emergency-response',
    name: '应急处置',
    purpose: '临时修复、恢复切换、演练与任务编排的执行',
    mergedFrom: ['快速响应', '恢复工程', '故障演练', '自动化编排'],
    inputs: ['处置计划', '服务拓扑', '可用技能'],
    outputs: ['临时修复动作', '恢复与切换提案', '编排执行记录'],
    toolScope: ['只读查询', '限流与重启提案', '切换与回滚提案'],
    riskCeiling: 'critical',
  },
  {
    id: 'observability-diagnosis',
    name: '观测诊断',
    purpose: '指标与日志分析、根因诊断与报告呈现',
    mergedFrom: ['观测分析', '根因诊断', '知识呈现'],
    inputs: ['指标流', '日志', '变更记录'],
    outputs: ['异常检测结论', '根因假设', '复盘报告'],
    toolScope: ['只读查询', '隔离环境实验'],
    riskCeiling: 'medium',
  },
  {
    id: 'security-governance',
    name: '安全治理',
    purpose: '审批策略、变更评审与资源成本治理',
    mergedFrom: ['安全审查', '变更治理', '资源治理'],
    inputs: ['待审动作', '策略规则', '资源与成本数据'],
    outputs: ['审批结论', '评审意见', '配额与成本建议'],
    toolScope: ['策略查询', '审批决策', '配额变更提案'],
    riskCeiling: 'high',
  },
  {
    id: 'skill-management',
    name: '技能管理',
    purpose: '技能目录、版本与运维资产管理',
    mergedFrom: ['技能管理'],
    inputs: ['技能清单', '版本与依赖', '使用记录'],
    outputs: ['技能清单快照', '启停建议'],
    toolScope: ['技能注册表读写'],
    riskCeiling: 'medium',
  },
]

export const RESPONSIBILITY_MODULE_IDS: readonly string[] = RESPONSIBILITY_MODULES.map(
  (module) => module.id,
)

const MODULE_BY_ID = new Map(RESPONSIBILITY_MODULES.map((module) => [module.id, module]))

export function findResponsibilityModule(id: string): ResponsibilityModule | undefined {
  return MODULE_BY_ID.get(id)
}

export function responsibilityModuleName(id: string): string {
  return MODULE_BY_ID.get(id)?.name ?? id
}
