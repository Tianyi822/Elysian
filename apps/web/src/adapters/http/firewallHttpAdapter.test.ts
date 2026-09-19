import { describe, expect, it } from 'vitest'
import { parseFirewallOverviewResponse } from './firewallHttpAdapter'

describe('parseFirewallOverviewResponse', () => {
  const valid = {
    toggles: { firewallEnabled: true, pingBlocked: false },
    rules: [
      {
        id: 'ufw-allow-in-tcp-8080-any.ipv4',
        protocol: 'tcp',
        port: 8080,
        family: 'ipv4',
        status: 'unused',
        policy: 'allow',
        direction: 'inbound',
        source: '所有IP',
        note: null,
        updatedAt: null,
      },
    ],
  }

  it('接受开关与规则数组', () => {
    const overview = parseFirewallOverviewResponse(valid)
    expect(overview.toggles).toEqual({ firewallEnabled: true, pingBlocked: false })
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
})
