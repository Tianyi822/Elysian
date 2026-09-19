import { describe, expect, it } from 'vitest'
import {
  canonicalId,
  displayPortOf,
  isValidFirewallAddress,
  parseIpv6Enabled,
  parseRuleId,
  parseShowAdded,
  parseStatusVerbose,
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
ufw deny from 203.0.113.9`

const EMPTY_CONTEXT = {
  ipv6Enabled: true,
  listeners: new Set<string>(['tcp:80']),
  updatedAtMap: new Map<string, string>(),
}

describe('parseShowAdded', () => {
  it('解析全部真实输出形态', () => {
    const lines = parseShowAdded(SHOW_ADDED_FIXTURE)
    expect(lines).toHaveLength(7) // 无端口的 deny from 不进端口规则
    expect(lines[0]?.spec).toEqual({ action: 'allow', direction: 'in', port: '22', proto: 'tcp', from: 'any' })
    expect(lines[0]?.comment).toBeNull()
    expect(lines[1]?.comment).toBe('Web server')
    expect(lines[2]?.comment).toBe('测试备注 note')
    expect(lines[3]?.spec).toMatchObject({ direction: 'out', port: '25', proto: 'udp' })
    expect(lines[4]?.spec).toMatchObject({ action: 'deny', port: '23', proto: 'tcp' })
    expect(lines[5]?.spec).toMatchObject({ action: 'limit', port: '2222', proto: 'tcp' })
    expect(lines[6]?.spec).toEqual({ action: 'allow', direction: 'in', port: '2049', proto: 'tcp', from: '192.168.1.0/24' })
  })

  it('空规则输出 (None) 不产生规则', () => {
    expect(parseShowAdded("Added user rules (see 'ufw status' for running firewall):\n(None)")).toHaveLength(0)
  })
})

describe('parseStatusVerbose', () => {
  it('识别激活与未激活', () => {
    expect(parseStatusVerbose('Status: active\nLogging: on (low)\n').active).toBe(true)
    expect(parseStatusVerbose('Status: inactive\n').active).toBe(false)
  })

  it('缺少 Status 行时报中文错误', () => {
    expect(() => parseStatusVerbose('')).toThrow('ufw status 输出无效')
  })
})

describe('parseIpv6Enabled', () => {
  it('读 /etc/default/ufw 的 IPV6 取值', () => {
    expect(parseIpv6Enabled('IPV6=yes\nIPV6_DENY=no\n')).toBe(true)
    expect(parseIpv6Enabled('IPV6=no\n')).toBe(false)
  })
})

describe('specFromInput 与 specToArgs 往返', () => {
  it('所有IP入站映射为短形式', () => {
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
  })

  it('出站映射带 out，来源映射为 from 完整形式', () => {
    const spec = specFromInput({
      protocol: 'udp',
      port: 53,
      family: 'ipv6',
      policy: 'deny',
      direction: 'outbound',
      source: 'fd00::/8',
      note: null,
    })
    expect(specToArgs(spec)).toEqual(['deny', 'out', 'from', 'fd00::/8', 'to', 'any', 'port', '53', 'proto', 'udp'])
  })

  it('端口、协议、来源不合法时抛中文错误', () => {
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
    expect(() => specFromInput({ ...base, source: 'example.com' })).toThrow('来源无效')
    expect(() => specFromInput({ ...base, source: "evil'; rm -rf /" })).toThrow('来源无效')
    expect(() => specFromInput({ ...base, note: "it's" })).toThrow('备注不能包含单引号')
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
      status: 'normal', // listeners 里有 tcp:80
      policy: 'allow',
      direction: 'inbound',
      source: '所有IP',
      note: 'Web',
      updatedAt: null,
    })
    // 两行同指纹不同地址族后缀
    expect(rows[0]!.id.endsWith('.ipv4')).toBe(true)
    expect(rows[1]!.id.endsWith('.ipv6')).toBe(true)
  })

  it('无监听记未使用，updatedAt 从会话账本带出', () => {
    const spec = specFromInput({
      protocol: 'tcp',
      port: 22,
      family: 'ipv4',
      policy: 'allow',
      direction: 'inbound',
      source: SOURCE_ALL_IPS,
      note: null,
    })
    const rows = ruleRowsFromSpec(spec, null, {
      ...EMPTY_CONTEXT,
      updatedAtMap: new Map([[canonicalId(spec), '2026-09-19T00:00:00.000Z']]),
    })
    expect(rows[0]).toMatchObject({ status: 'unused', note: null, updatedAt: '2026-09-19T00:00:00.000Z' })
  })

  it('来源网段决定单地址族行，limit 呈现为放行', () => {
    const spec = { action: 'limit' as const, direction: 'in' as const, proto: 'tcp' as const, port: '2222', from: '192.168.1.0/24' }
    const rows = ruleRowsFromSpec(spec, null, EMPTY_CONTEXT)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ family: 'ipv4', policy: 'allow', source: '192.168.1.0/24' })
  })

  it('端口段用起始端口呈现并在备注保留完整端口段', () => {
    const spec = { action: 'allow' as const, direction: 'in' as const, proto: 'tcp' as const, port: '1000:2000', from: 'any' }
    const rows = ruleRowsFromSpec(spec, null, EMPTY_CONTEXT)
    expect(rows[0]).toMatchObject({ port: 1000, note: '端口段 1000:2000' })
    expect(displayPortOf(spec)).toBe(1000)
  })
})

describe('parseRuleId', () => {
  it('从界面行 id 还原规范指纹与地址族', () => {
    const spec = { action: 'allow' as const, direction: 'in' as const, proto: 'tcp' as const, port: '2049', from: '192.168.1.0/24' }
    const parsed = parseRuleId(`${canonicalId(spec)}.ipv6`)
    expect(parsed).not.toBeNull()
    expect(parsed!.spec).toEqual(spec)
    expect(parsed!.family).toBe('ipv6')
  })

  it('不认识的 id 返回 null', () => {
    expect(parseRuleId('fw-80-ipv4')).toBeNull()
    expect(parseRuleId('ufw-allow-tcp-22-any')).toBeNull()
  })
})
