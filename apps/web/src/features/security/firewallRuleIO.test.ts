import { describe, expect, it } from 'vitest'
import { SEED_RULES } from '../../adapters/mock/firewallData'
import {
  buildExportFilename,
  buildExportPayload,
  filterRulesByDirection,
  formatFirewallImportProblems,
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

  it('备注含单引号或控制字符的条目整批先拒收，逐条标出原因，合法条目照常进导入集', () => {
    const result = parseFirewallRulesJson(
      JSON.stringify([
        { protocol: 'tcp', port: 8443, family: 'ipv4', policy: 'allow', note: '演示入口' },
        { protocol: 'tcp', port: 8444, family: 'ipv4', policy: 'allow', note: "演示'入口" },
        { protocol: 'tcp', port: 8445, family: 'ipv4', policy: 'allow', note: '演示\n入口' },
        { protocol: 'tcp', port: 8446, family: 'ipv4', policy: 'allow', note: '演示\u0007入口' },
      ]),
    )!
    // 判据与服务端 ufw 场景一致：这些条目不再放行到服务端循环里抛错
    expect(result.rules).toHaveLength(1)
    expect(result.rules[0]).toMatchObject({ port: 8443, note: '演示入口' })
    expect(result.invalid).toBe(3)
    // 逐条标出：序号是条目在文件里的位置（从 1 计），原因与服务端同一句中文错误
    expect(result.problems).toEqual([
      { index: 2, reason: '备注不能包含单引号' },
      { index: 3, reason: '备注不能包含换行或控制字符' },
      { index: 4, reason: '备注不能包含换行或控制字符' },
    ])
  })

  it('结构不合法的条目同样逐条标出，不拖垮整批', () => {
    const result = parseFirewallRulesJson(
      JSON.stringify([
        '不是对象',
        { protocol: 'tcp', port: 70000, family: 'ipv4', policy: 'allow' },
        { protocol: 'tcp', port: 8443, family: 'ipv4', policy: 'allow' },
      ]),
    )!
    expect(result.rules).toHaveLength(1)
    expect(result.invalid).toBe(2)
    expect(result.problems).toEqual([
      { index: 1, reason: '条目不是 JSON 对象' },
      { index: 2, reason: '协议、端口、地址族、策略或方向不合法' },
    ])
  })

  it('备注为空或不填仍放行（空备注归一为 null）', () => {
    const result = parseFirewallRulesJson(
      JSON.stringify([
        { protocol: 'tcp', port: 8443, family: 'ipv4', policy: 'allow' },
        { protocol: 'tcp', port: 8444, family: 'ipv4', policy: 'allow', note: '   ' },
      ]),
    )!
    expect(result.rules).toHaveLength(2)
    expect(result.rules.map((rule) => rule.note)).toEqual([null, null])
    expect(result.problems).toEqual([])
  })

  it('被拒条目拼成界面原样呈现的清单：逐条给出序号与原因', () => {
    expect(
      formatFirewallImportProblems([
        { index: 2, reason: '备注不能包含单引号' },
        { index: 5, reason: '协议、端口、地址族、策略或方向不合法' },
      ]),
    ).toBe('第 2 条：备注不能包含单引号；第 5 条：协议、端口、地址族、策略或方向不合法')
    expect(formatFirewallImportProblems([])).toBe('')
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
