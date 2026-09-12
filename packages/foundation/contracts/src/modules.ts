import type { RiskLevel } from './enums'

/**
 * 职责模块：中性的职责名词单元。每个模块都有明确的输入、输出、工具范围与风险上限，
 * 且都不是可以绕过统一策略的独立权限主体。
 */
export type ResponsibilityModule = {
  id: string
  name: string
  purpose: string
  inputs: readonly string[]
  outputs: readonly string[]
  toolScope: readonly string[]
  /** 风险上限：该模块允许提出的动作最高风险等级，超过即必须转人工。 */
  riskCeiling: RiskLevel
}

export const RESPONSIBILITY_MODULES: readonly ResponsibilityModule[] = [
  {
    id: 'coordination',
    name: '协调中心',
    purpose: '总协调与用户交互',
    inputs: ['用户指令', '各模块运行状态', '事故概况'],
    outputs: ['派发给职责模块的任务', '给用户的进展说明'],
    toolScope: ['只读查询', '通知'],
    riskCeiling: 'low',
  },
  {
    id: 'incident-command',
    name: '事故指挥',
    purpose: '重大事故的指挥与决策',
    inputs: ['事故详情', '各模块判断', '资源与影响范围'],
    outputs: ['处置计划', '动作提案', '处置优先级'],
    toolScope: ['只读查询', '动作提案'],
    riskCeiling: 'high',
  },
  {
    id: 'security-review',
    name: '安全审查',
    purpose: '安全策略与审批',
    inputs: ['待审动作', '策略规则', '影响范围'],
    outputs: ['审批结论', '风险标注', '拒绝理由'],
    toolScope: ['策略查询', '审批决策'],
    riskCeiling: 'high',
  },
  {
    id: 'resource-governance',
    name: '资源治理',
    purpose: '资源与成本治理',
    inputs: ['资源用量', '成本数据', '容量水位'],
    outputs: ['配额建议', '资源调整提案'],
    toolScope: ['资源查询', '配额变更提案'],
    riskCeiling: 'high',
  },
  {
    id: 'automation-orchestration',
    name: '自动化编排',
    purpose: '工作流、脚本与工具编排',
    inputs: ['处置计划', '可用技能', '执行结果'],
    outputs: ['编排后的任务链', '执行记录'],
    toolScope: ['工作流编排', '工具调用'],
    riskCeiling: 'high',
  },
  {
    id: 'fault-drill',
    name: '故障演练',
    purpose: '故障处置与压力测试',
    inputs: ['演练计划', '目标服务', '流量模型'],
    outputs: ['演练报告', '容量与韧性结论'],
    toolScope: ['压测', '流量切换'],
    riskCeiling: 'critical',
  },
  {
    id: 'observability-analysis',
    name: '观测分析',
    purpose: '指标、日志与趋势预测',
    inputs: ['指标流', '日志', '变更记录'],
    outputs: ['指标摘要', '异常检测结论', '趋势预测'],
    toolScope: ['只读查询'],
    riskCeiling: 'low',
  },
  {
    id: 'rapid-response',
    name: '快速响应',
    purpose: '低延迟告警响应与临时修复',
    inputs: ['告警', '服务拓扑', '历史处置'],
    outputs: ['临时修复动作', '告警抑制建议'],
    toolScope: ['只读查询', '限流与重启提案'],
    riskCeiling: 'high',
  },
  {
    id: 'recovery-engineering',
    name: '恢复工程',
    purpose: '可用性、灾备与恢复',
    inputs: ['故障范围', '备份与副本状态', '恢复预案'],
    outputs: ['恢复方案', '回滚动作', '切换提案'],
    toolScope: ['切换与回滚提案', '备份查询'],
    riskCeiling: 'critical',
  },
  {
    id: 'root-cause-diagnosis',
    name: '根因诊断',
    purpose: '根因分析与实验诊断',
    inputs: ['证据集', '变更记录', '复现条件'],
    outputs: ['根因假设', '验证实验设计', '诊断结论'],
    toolScope: ['只读查询', '隔离环境实验'],
    riskCeiling: 'medium',
  },
  {
    id: 'knowledge-presentation',
    name: '知识呈现',
    purpose: '可视化、报告与知识表达',
    inputs: ['事故数据', '时间线', '诊断结论'],
    outputs: ['复盘报告', '可视化视图'],
    toolScope: ['只读查询'],
    riskCeiling: 'low',
  },
  {
    id: 'change-governance',
    name: '变更治理',
    purpose: '变更评审与经验沉淀',
    inputs: ['变更单', '评审规则', '事故复盘'],
    outputs: ['评审意见', '变更风险标注'],
    toolScope: ['变更查询', '评审记录'],
    riskCeiling: 'medium',
  },
  {
    id: 'skill-management',
    name: '技能管理',
    purpose: '技能目录、版本与运维资产管理',
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
