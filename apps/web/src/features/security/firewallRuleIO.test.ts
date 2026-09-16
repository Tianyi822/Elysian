import { describe, expect, it } from 'vitest'
import { SEED_RULES } from '../../adapters/mock/firewallData'
import {
  buildExportFilename,
  buildExportPayload,
  filterRulesByDirection,
  parseFirewallRulesJson,
} from './firewallRuleIO'

describe('防火墙规则导入解析', () => {
  it('接受导出格式与裸数组两种形状', () => {
    const wrapped = parseFirewallRulesJson(
      JSON.stringify({ kind: 'elysian-firewall-rules', rules: SEED_RULES.slice(0, 2) }),
    )
    expect(wrapped?.rules).toHaveLength(2)
    expect(wrapped?.invalid).toBe(0)

    const bare = parseFirewallRulesJson(JSON.stringify([SEED_RULES[0]]))
    expect(bare?.rules).toHaveLength(1)
  })

  it('每条都校验：端口范围、协议、地址族、策略不合法就跳过并计数', () => {
    const result = parseFirewallRulesJson(
      JSON.stringify([
        { protocol: 'tcp', port: 8080, family: 'ipv4', policy: 'allow', source: '所有IP' },
        { protocol: 'sctp', port: 8081, family: 'ipv4', policy: 'allow' },
        { protocol: 'tcp', port: 0, family: 'ipv4', policy: 'allow' },
        { protocol: 'tcp', port: 70000, family: 'ipv4', policy: 'allow' },
        { protocol: 'tcp', port: 8082, family: 'ipx', policy: 'allow' },
        { protocol: 'tcp', port: 8083, family: 'ipv4', policy: 'maybe' },
        { protocol: 'udp', port: 53, family: 'ipv6', policy: 'deny', direction: 'outbound' },
      ]),
    )!
    expect(result.rules).toHaveLength(2)
    expect(result.rules[1]).toMatchObject({ protocol: 'udp', port: 53, direction: 'outbound' })
    expect(result.invalid).toBe(5)
  })

  it('缺省字段补全：方向默认入站，来源默认所有IP，空备注归一为 null', () => {
    const result = parseFirewallRulesJson(
      JSON.stringify([{ protocol: 'tcp', port: 8443, family: 'ipv4', policy: 'deny' }]),
    )!
    expect(result.rules[0]).toEqual({
      protocol: 'tcp',
      port: 8443,
      family: 'ipv4',
      policy: 'deny',
      source: '所有IP',
      note: null,
    })
  })

  it('不是 JSON 或结构不对返回 null，交给界面报错', () => {
    expect(parseFirewallRulesJson('{ not json')).toBeNull()
    expect(parseFirewallRulesJson('{"kind":"x"}')).toBeNull()
    expect(parseFirewallRulesJson('"just a string"')).toBeNull()
  })
})

describe('防火墙规则导出', () => {
  it('按方向过滤：出站 0 条、入站即全部（种子规则都是入站）', () => {
    expect(filterRulesByDirection(SEED_RULES, 'all')).toHaveLength(SEED_RULES.length)
    expect(filterRulesByDirection(SEED_RULES, 'inbound')).toHaveLength(SEED_RULES.length)
    expect(filterRulesByDirection(SEED_RULES, 'outbound')).toHaveLength(0)
  })

  it('导出载荷带 kind、方向与时间；文件名含方向与日期', () => {
    const exportedAt = '2026-09-16T08:00:00.000Z'
    const payload = buildExportPayload(SEED_RULES.slice(0, 1), 'inbound', exportedAt)
    expect(payload.kind).toBe('elysian-firewall-rules')
    expect(payload.direction).toBe('inbound')
    expect(payload.rules).toHaveLength(1)

    expect(buildExportFilename('inbound', exportedAt)).toBe('elysian-firewall-inbound-20260916.json')
    expect(buildExportFilename('all', exportedAt)).toBe('elysian-firewall-all-20260916.json')
  })
})
