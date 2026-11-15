import { describe, expect, it } from 'vitest'
import { SEED_RULES } from '../../adapters/mock/firewallData'
import { isProtectedPanelRule, portRuleGroup } from './securityTableLogic'

describe('防火墙表格批量目标', () => {
  it('同规范规则的两地址族只编为一个动作，备注和采样变化不改变分组', () => {
    const row = SEED_RULES[0]!
    expect(portRuleGroup(row)).toBe(portRuleGroup({ ...row, family: 'ipv6', note: '新备注', status: 'normal' }))
    expect(portRuleGroup(row)).not.toBe(portRuleGroup({ ...row, source: '192.0.2.1' }))
    expect(portRuleGroup(row)).not.toBe(portRuleGroup({ ...row, policy: 'deny' }))
  })
  it('按实际配置保护入口放行规则，端口段和定向来源不被误判为保底规则', () => {
    const row = { ...SEED_RULES[0]!, port: 49000, portTo: null, protocol: 'tcp' as const, policy: 'allow' as const, direction: 'inbound' as const, source: '所有IP' }
    expect(isProtectedPanelRule(row, 49000)).toBe(true)
    expect(isProtectedPanelRule(row, 48100)).toBe(false)
    expect(isProtectedPanelRule({ ...row, portTo: 49001 }, 49000)).toBe(false)
    expect(isProtectedPanelRule({ ...row, source: '192.0.2.1' }, 49000)).toBe(false)
  })
})
