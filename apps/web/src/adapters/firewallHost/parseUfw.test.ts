import { describe, expect, it } from 'vitest'
import {
  canonicalId,
  displayPortOf,
  ipCanonicalId,
  ipRuleIdOf,
  ipRuleRowFromSpec,
  ipSpecFromInput,
  isValidFirewallAddress,
  parseIpRuleId,
  parseIpv6Enabled,
  parseRuleId,
  parseShowAdded,
  parseStatusVerbose,
  portToOf,
  ruleRowsFromSpec,
  specFromInput,
  specToArgs,
  SOURCE_ALL_IPS,
} from './parseUfw'

const SHOW_ADDED_FIXTURE = `Added user rules (see 'ufw status' for running firewall):
ufw allow 22/tcp
ufw allow 80/tcp comment 'Web server'
ufw allow 60123/tcp comment '测试备注 note'
ufw allow out 25/udp
ufw deny 23/tcp
ufw limit 2222/tcp
ufw allow from 192.168.1.0/24 to any port 2049 proto tcp
ufw deny from 203.0.113.9
ufw allow from 2001:db8::/32
ufw deny to 10.0.0.5`

const EMPTY_CONTEXT = {
  ipv6Enabled: true,
  listeners: new Set<string>(['tcp:80']),
  updatedAtMap: new Map<string, string>(),
}

describe('parseShowAdded', () => {
  it('解析端口规则与 IP 规则，无对应物的行不返回', () => {
    const lines = parseShowAdded(SHOW_ADDED_FIXTURE)
    expect(lines).toHaveLength(9) // 7 端口 + 2 IP；deny to（目的封禁）没有界面对应物
    const portLines = lines.filter((line) => line.kind === 'port')
    const ipLines = lines.filter((line) => line.kind === 'ip')
    expect(portLines).toHaveLength(7)
    expect(ipLines).toHaveLength(2)

    expect(portLines[0]?.spec).toEqual({ action: 'allow', direction: 'in', port: '22', proto: 'tcp', from: 'any' })
    expect(portLines[1]?.comment).toBe('Web server')
    expect(portLines[3]?.spec).toMatchObject({ direction: 'out', port: '25', proto: 'udp' })
    expect(portLines[4]?.spec).toMatchObject({ action: 'deny', port: '23', proto: 'tcp' })
    expect(portLines[5]?.spec).toMatchObject({ action: 'limit', port: '2222', proto: 'tcp' })
    expect(portLines[6]?.spec).toEqual({ action: 'allow', direction: 'in', port: '2049', proto: 'tcp', from: '192.168.1.0/24' })

    expect(ipLines[0]?.spec).toEqual({ action: 'deny', direction: 'in', from: '203.0.113.9' })
    expect(ipLines[1]?.spec).toEqual({ action: 'allow', direction: 'in', from: '2001:db8::/32' })
  })

  it('空规则输出 (None) 不产生规则', () => {
    expect(parseShowAdded("Added user rules (see 'ufw status' for running firewall):\n(None)")).toHaveLength(0)
  })
})

describe('parseStatusVerbose', () => {
  it('识别激活状态并解析默认策略', () => {
    const status = parseStatusVerbose('Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n')
    expect(status).toEqual({ active: true, defaultIncoming: 'deny', defaultOutgoing: 'allow' })
    expect(parseStatusVerbose('Status: inactive\nDefault: allow (incoming), deny (outgoing), disabled (routed)\n')).toEqual({
      active: false,
      defaultIncoming: 'allow',
      defaultOutgoing: 'deny',
    })
  })

  it('缺少 Status 或 Default 行时报中文错误', () => {
    expect(() => parseStatusVerbose('Default: deny (incoming), allow (outgoing)\n')).toThrow('缺少 Status 行')
    expect(() => parseStatusVerbose('Status: active\n')).toThrow('缺少 Default 行')
  })
})

describe('parseIpv6Enabled', () => {
  it('读 /etc/default/ufw 的 IPV6 取值', () => {
    expect(parseIpv6Enabled('IPV6=yes\nIPV6_DENY=no\n')).toBe(true)
    expect(parseIpv6Enabled('IPV6=no\n')).toBe(false)
  })
})

describe('specFromInput 与 specToArgs 往返', () => {
  it('所有IP入站映射为短形式；端口段保留冒号', () => {
    const spec = specFromInput({
      protocol: 'tcp',
      port: 8080,
      family: 'ipv4',
      policy: 'allow',
      direction: 'inbound',
      source: SOURCE_ALL_IPS,
      note: null,
    })
    expect(specToArgs(spec)).toEqual(['allow', '8080/tcp'])

    const range = specFromInput({
      protocol: 'tcp',
      port: 1000,
      portTo: 2000,
      family: 'ipv4',
      policy: 'allow',
      direction: 'inbound',
      source: SOURCE_ALL_IPS,
      note: null,
    })
    expect(range.port).toBe('1000:2000')
    expect(specToArgs(range)).toEqual(['allow', '1000:2000/tcp'])
  })

  it('出站映射带 out，来源映射为 from 完整形式，limit 作为动作透传', () => {
    const spec = specFromInput({
      protocol: 'udp',
      port: 53,
      family: 'ipv6',
      policy: 'limit',
      direction: 'outbound',
      source: 'fd00::/8',
      note: null,
    })
    expect(specToArgs(spec)).toEqual(['limit', 'out', 'from', 'fd00::/8', 'to', 'any', 'port', '53', 'proto', 'udp'])
  })

  it('端口、协议、来源、端口段不合法时抛中文错误', () => {
    const base = {
      protocol: 'tcp' as const,
      port: 80,
      family: 'ipv4' as const,
      policy: 'allow' as const,
      direction: 'inbound' as const,
      source: SOURCE_ALL_IPS,
      note: null,
    }
    expect(() => specFromInput({ ...base, port: 0 })).toThrow('端口无效')
    expect(() => specFromInput({ ...base, port: 70000 })).toThrow('端口无效')
    expect(() => specFromInput({ ...base, port: 2000, portTo: 1000 })).toThrow('端口段无效')
    expect(() => specFromInput({ ...base, source: 'example.com' })).toThrow('来源无效')
    expect(() => specFromInput({ ...base, source: "evil'; rm -rf /" })).toThrow('来源无效')
    expect(() => specFromInput({ ...base, note: "it's" })).toThrow('备注不能包含单引号')
  })
})

describe('ipSpecFromInput', () => {
  it('合法来源映射为 IP 规则规范', () => {
    expect(ipSpecFromInput({ policy: 'deny', source: '203.0.113.0/24', note: null })).toEqual({
      action: 'deny',
      direction: 'in',
      from: '203.0.113.0/24',
    })
  })

  it('拒绝所有IP与非法来源（纯来源封禁必须是具体地址）', () => {
    expect(() => ipSpecFromInput({ policy: 'deny', source: SOURCE_ALL_IPS, note: null })).toThrow('来源无效')
    expect(() => ipSpecFromInput({ policy: 'deny', source: 'example.com', note: null })).toThrow('来源无效')
    expect(() => ipSpecFromInput({ policy: 'weird' as 'deny', source: '1.2.3.4', note: null })).toThrow('策略无效')
  })
})

describe('isValidFirewallAddress', () => {
  it('接受合法 IP 与网段，拒绝其余', () => {
    expect(isValidFirewallAddress('192.168.1.1')).toBe(true)
    expect(isValidFirewallAddress('10.0.0.0/8')).toBe(true)
    expect(isValidFirewallAddress('fd00::1')).toBe(true)
    expect(isValidFirewallAddress('2001:db8::/32')).toBe(true)
    expect(isValidFirewallAddress('999.1.1.1')).toBe(false)
    expect(isValidFirewallAddress('10.0.0.0/40')).toBe(false)
    expect(isValidFirewallAddress('所有IP')).toBe(false)
  })
})

describe('ruleRowsFromSpec', () => {
  it('any 来源在 IPv6 启用时派生 v4/v6 两行，监听状态来自真实套接字', () => {
    const spec = specFromInput({
      protocol: 'tcp',
      port: 80,
      family: 'ipv4',
      policy: 'allow',
      direction: 'inbound',
      source: SOURCE_ALL_IPS,
      note: 'Web',
    })
    const rows = ruleRowsFromSpec(spec, 'Web', EMPTY_CONTEXT)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.family)).toEqual(['ipv4', 'ipv6'])
    expect(rows[0]).toMatchObject({
      protocol: 'tcp',
      port: 80,
      portTo: null,
      status: 'normal', // listeners 里有 tcp:80
      policy: 'allow',
      direction: 'inbound',
      source: '所有IP',
      note: 'Web',
      updatedAt: null,
    })
    expect(rows[0]!.id.endsWith('.ipv4')).toBe(true)
    expect(rows[1]!.id.endsWith('.ipv6')).toBe(true)
  })

  it('端口段行带 portTo，备注合并端口段说明', () => {
    const spec = specFromInput({
      protocol: 'tcp',
      port: 1000,
      portTo: 2000,
      family: 'ipv4',
      policy: 'allow',
      direction: 'inbound',
      source: SOURCE_ALL_IPS,
      note: '被动模式',
    })
    const rows = ruleRowsFromSpec(spec, '被动模式', EMPTY_CONTEXT)
    expect(rows[0]).toMatchObject({ port: 1000, portTo: 2000, note: '端口段 1000:2000；被动模式' })
    expect(portToOf(spec)).toBe(2000)
    expect(displayPortOf(spec)).toBe(1000)
  })

  it('limit 规则的策略呈现为「限连」，updatedAt 从账本带出', () => {
    const spec = specFromInput({
      protocol: 'tcp',
      port: 22,
      family: 'ipv4',
      policy: 'limit',
      direction: 'inbound',
      source: SOURCE_ALL_IPS,
      note: null,
    })
    const rows = ruleRowsFromSpec(spec, null, {
      ...EMPTY_CONTEXT,
      updatedAtMap: new Map([[canonicalId(spec), '2026-09-19T00:00:00.000Z']]),
    })
    expect(rows[0]).toMatchObject({ policy: 'limit', status: 'unused', updatedAt: '2026-09-19T00:00:00.000Z' })
  })

  it('来源网段决定单地址族行', () => {
    const spec = { action: 'allow' as const, direction: 'in' as const, proto: 'tcp' as const, port: '2049', from: '192.168.1.0/24' }
    const rows = ruleRowsFromSpec(spec, null, EMPTY_CONTEXT)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ family: 'ipv4', source: '192.168.1.0/24' })
  })
})

describe('IP 规则行', () => {
  it('地址族由来源形态决定，id 与 canonical 指纹对应', () => {
    const spec = { action: 'deny' as const, direction: 'in' as const, from: '203.0.113.9' }
    const row = ipRuleRowFromSpec(spec, '恶意扫描', EMPTY_CONTEXT)
    expect(row).toMatchObject({ source: '203.0.113.9', family: 'ipv4', policy: 'deny', note: '恶意扫描', updatedAt: null })
    expect(row.id).toBe(`${ipCanonicalId(spec)}.ipv4`)
    expect(ipRuleIdOf(spec)).toBe(row.id)

    const v6 = ipRuleRowFromSpec({ action: 'allow', direction: 'in', from: 'fd00::/8' }, null, EMPTY_CONTEXT)
    expect(v6.family).toBe('ipv6')
  })
})

describe('parseRuleId / parseIpRuleId', () => {
  it('从界面行 id 还原端口规则规范指纹与地址族', () => {
    const spec = { action: 'allow' as const, direction: 'in' as const, proto: 'tcp' as const, port: '2049', from: '192.168.1.0/24' }
    const parsed = parseRuleId(`${canonicalId(spec)}.ipv6`)
    expect(parsed).not.toBeNull()
    expect(parsed!.spec).toEqual(spec)
    expect(parsed!.family).toBe('ipv6')
  })

  it('从界面行 id 还原 IP 规则规范与地址族', () => {
    const parsed = parseIpRuleId(`${ipCanonicalId({ action: 'deny', direction: 'in', from: '203.0.113.9' })}.ipv4`)
    expect(parsed).toEqual({ spec: { action: 'deny', direction: 'in', from: '203.0.113.9' }, family: 'ipv4' })
  })

  it('不认识的 id 返回 null', () => {
    expect(parseRuleId('fw-80-ipv4')).toBeNull()
    expect(parseRuleId('ufw-allow-tcp-22-any')).toBeNull()
    expect(parseIpRuleId('fwip-x')).toBeNull()
  })
})
