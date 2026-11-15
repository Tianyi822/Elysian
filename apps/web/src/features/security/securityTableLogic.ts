import type { FirewallRule } from '@elysian/contracts'

/** 地址族仅是同一条 UFW 规则的两种展示；备注与采样状态不属于规则身份。 */
export const portRuleGroup = (rule: FirewallRule): string => JSON.stringify([rule.protocol, rule.port, rule.portTo, rule.policy, rule.direction, rule.source])

export const isProtectedPanelRule = (rule: FirewallRule, frontendPort: number): boolean =>
  rule.protocol === 'tcp' && rule.port === frontendPort && rule.portTo === null
  && rule.policy === 'allow' && rule.direction === 'inbound' && ['所有IP', 'any'].includes(rule.source)
