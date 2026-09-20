import { describe, expect, it } from 'vitest'
import {
  parseFirewallOverviewResponse,
  parseForwardResponse,
  parseForwardRulesResponse,
  parseIpRuleResponse,
  parseIpRulesResponse,
  parseRuleResponse,
  parseScanResponse,
} from './firewallHttpAdapter'

/*
 * 防火墙 HTTP adapter 的响应形状校验测试：形状漂移必须在 adapter 层拦下并抛中文错误，
 * 不能把任意结构 cast 进 store 与渲染。fixture 字段与契约逐字段对齐。
 */

const RULE = {
  id: 'ufw-allow-in-tcp-8080-any.ipv4',
  protocol: 'tcp',
  port: 8080,
  portTo: null,
  family: 'ipv4',
  status: 'unused',
  policy: 'allow',
  direction: 'inbound',
  source: '所有IP',
  note: null,
  updatedAt: null,
}

const IP_RULE = {
  id: 'ufw-deny-from-203.0.113.9',
  source: '203.0.113.9',
  family: 'ipv4',
  policy: 'deny',
  note: null,
  updatedAt: null,
}

const FORWARD = {
  id: 'fwd-tcp-2222-to-10.0.0.5-22',
  protocol: 'tcp',
  port: 2222,
  portTo: null,
  targetHost: '10.0.0.5',
  targetPort: 22,
  note: null,
  updatedAt: null,
}

const SCAN = {
  enabled: true,
  config: { ports: [22, 3389], windowSeconds: 60, hitCount: 8, banSeconds: 3600 },
  stats: { totalBlockedIps: 3, totalFailedConnections: 1200, currentBlockedIps: 1, currentFailedConnections: 40 },
  blocked: [{ ip: '203.0.113.9', blockedAt: '2026-09-20T08:00:00.000Z' }],
}

describe('parseFirewallOverviewResponse', () => {
  const valid = {
    toggles: {
      firewallEnabled: true,
      pingBlocked: false,
      defaultIncoming: 'deny',
      defaultOutgoing: 'allow',
    },
    rules: [RULE],
  }

  it('接受开关（含默认策略）与规则数组', () => {
    const overview = parseFirewallOverviewResponse(valid)
    expect(overview.toggles).toEqual({
      firewallEnabled: true,
      pingBlocked: false,
      defaultIncoming: 'deny',
      defaultOutgoing: 'allow',
    })
    expect(overview.rules).toHaveLength(1)
  })

  it('非对象或缺少数组时抛中文错误', () => {
    expect(() => parseFirewallOverviewResponse(null)).toThrow('防火墙响应格式无效')
    expect(() =>
      parseFirewallOverviewResponse({ toggles: { firewallEnabled: true, pingBlocked: true }, rules: 'nope' }),
    ).toThrow('防火墙规则响应无效')
    expect(() =>
      parseFirewallOverviewResponse({ toggles: { firewallEnabled: 'yes', pingBlocked: false }, rules: [] }),
    ).toThrow('防火墙开关响应无效')
  })

  it('规则数组里混入形状漂移的行时抛中文错误，不整批 cast 进 store', () => {
    expect(() => parseFirewallOverviewResponse({ toggles: valid.toggles, rules: [{ ...RULE, protocol: 'icmp' }] })).toThrow(
      '防火墙端口规则响应无效',
    )
  })
})

describe('parseRuleResponse / parseIpRuleResponse / parseForwardResponse', () => {
  it('合法的单条规则按字段还原', () => {
    expect(parseRuleResponse({ rule: RULE })).toEqual(RULE)
    expect(parseIpRuleResponse({ rule: IP_RULE })).toEqual(IP_RULE)
    expect(parseForwardResponse({ rule: FORWARD })).toEqual(FORWARD)
  })

  it('缺 rule 或 rule 非对象抛通用格式错误', () => {
    expect(() => parseRuleResponse({})).toThrow('防火墙响应格式无效')
    expect(() => parseIpRuleResponse({ rule: 'x' })).toThrow('防火墙响应格式无效')
    expect(() => parseForwardResponse(null)).toThrow('防火墙响应格式无效')
  })

  it('端口规则字段漂移逐字段拦下：协议、端口、可空字段', () => {
    expect(() => parseRuleResponse({ rule: { ...RULE, protocol: 'icmp' } })).toThrow('防火墙端口规则响应无效')
    expect(() => parseRuleResponse({ rule: { ...RULE, port: '8080' } })).toThrow('防火墙端口规则响应无效')
    expect(() => parseRuleResponse({ rule: { ...RULE, portTo: '8090' } })).toThrow('防火墙端口规则响应无效')
    expect(() => parseRuleResponse({ rule: { ...RULE, note: 42 } })).toThrow('防火墙端口规则响应无效')
    expect(() => parseRuleResponse({ rule: { ...RULE, family: 'ipv9' } })).toThrow('防火墙端口规则响应无效')
  })

  it('IP 规则字段漂移拦下：来源、地址族、策略', () => {
    expect(() => parseIpRuleResponse({ rule: { ...IP_RULE, source: 9 } })).toThrow('防火墙 IP 规则响应无效')
    expect(() => parseIpRuleResponse({ rule: { ...IP_RULE, family: 'mac' } })).toThrow('防火墙 IP 规则响应无效')
    expect(() => parseIpRuleResponse({ rule: { ...IP_RULE, policy: 'block' } })).toThrow('防火墙 IP 规则响应无效')
    expect(() => parseIpRuleResponse({ rule: { ...IP_RULE, updatedAt: 0 } })).toThrow('防火墙 IP 规则响应无效')
  })

  it('端口转发字段漂移拦下：目标地址、目标端口、可空端口段', () => {
    expect(() => parseForwardResponse({ rule: { ...FORWARD, targetHost: null } })).toThrow('防火墙端口转发响应无效')
    expect(() => parseForwardResponse({ rule: { ...FORWARD, targetPort: '22' } })).toThrow('防火墙端口转发响应无效')
    expect(() => parseForwardResponse({ rule: { ...FORWARD, portTo: '2230' } })).toThrow('防火墙端口转发响应无效')
  })
})

describe('parseIpRulesResponse / parseForwardRulesResponse', () => {
  it('合法列表逐条校验后还原', () => {
    expect(parseIpRulesResponse({ rules: [IP_RULE] })).toEqual([IP_RULE])
    expect(parseForwardRulesResponse({ rules: [FORWARD] })).toEqual([FORWARD])
  })

  it('非数组与形状漂移条目都拦下，不再静默回落空列表', () => {
    expect(() => parseIpRulesResponse({ rules: 'nope' })).toThrow('防火墙 IP 规则列表响应无效：应为数组')
    expect(() => parseIpRulesResponse({ rules: [{ ...IP_RULE, source: null }] })).toThrow('防火墙 IP 规则响应无效')
    expect(() => parseForwardRulesResponse({ rules: 0 })).toThrow('防火墙端口转发列表响应无效：应为数组')
    expect(() => parseForwardRulesResponse({ rules: [{ ...FORWARD, targetPort: null }] })).toThrow(
      '防火墙端口转发响应无效',
    )
  })
})

describe('parseScanResponse', () => {
  it('合法的防扫描数据按字段还原', () => {
    expect(parseScanResponse(SCAN)).toEqual(SCAN)
  })

  it('开关、配置、统计、封锁列表逐字段校验，漂移抛中文错误', () => {
    expect(() => parseScanResponse({ ...SCAN, enabled: 'on' })).toThrow('防火墙防扫描开关响应无效')
    expect(() => parseScanResponse({ ...SCAN, config: { ...SCAN.config, ports: [22, '3389'] } })).toThrow(
      '防火墙防扫描配置响应无效',
    )
    expect(() => parseScanResponse({ ...SCAN, config: { ...SCAN.config, windowSeconds: '60' } })).toThrow(
      '防火墙防扫描配置响应无效',
    )
    expect(() => parseScanResponse({ ...SCAN, stats: { ...SCAN.stats, currentBlockedIps: undefined } })).toThrow(
      '防火墙防扫描统计响应无效',
    )
    expect(() => parseScanResponse({ ...SCAN, blocked: 'nope' })).toThrow('防火墙防扫描封锁列表响应无效：应为数组')
    expect(() => parseScanResponse({ ...SCAN, blocked: [{ ip: '203.0.113.9' }] })).toThrow(
      '防火墙防扫描封锁条目响应无效',
    )
    expect(() => parseScanResponse(null)).toThrow('防火墙响应格式无效')
  })
})
