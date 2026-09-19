import { describe, expect, it } from 'vitest'
import {
  parseDropCounter,
  parseRecentList,
  parseScanEnabled,
  scanSectionLines,
  setScanEnabled,
  validateUnblockIp,
} from './scanRules'

const BASE_RULES = `*filter
:ufw-before-input - [0:0]
-A ufw-before-input -i lo -j ACCEPT
-A ufw-before-input -p icmp --icmp-type echo-request -j ACCEPT
COMMIT`

const ENABLED_RULES = `*filter
:ufw-before-input - [0:0]
-A ufw-before-input -i lo -j ACCEPT
-A ufw-before-input -p icmp --icmp-type echo-request -j ACCEPT
${scanSectionLines().join('\n')}
COMMIT`

const IPTABLES_LIST = `Chain ufw-before-input (1 references)
    pkts      bytes target     prot opt in     out     source               destination
     512    30720 ACCEPT     all  --  lo     *       0.0.0.0/0            0.0.0.0/0
      17     1020 DROP       tcp  --  *      *       0.0.0.0/0            0.0.0.0/0           multiport dports 22,23 tcp dpt:22 recent: CHECK seconds: 60 hit_count: 8 name: ELYSIAN_SCAN side: mask`

describe('parseScanEnabled', () => {
  it('规则段存在为启用，缺失为停用', () => {
    expect(parseScanEnabled(ENABLED_RULES)).toBe(true)
    expect(parseScanEnabled(BASE_RULES)).toBe(false)
  })
})

describe('setScanEnabled', () => {
  it('启用时在最后一个 COMMIT 前插入规则段', () => {
    const next = setScanEnabled(BASE_RULES, true)
    expect(parseScanEnabled(next)).toBe(true)
    expect(next).toContain('-m recent --name ELYSIAN_SCAN --set')
    expect(next).toContain('--rcheck --seconds 60 --hitcount 8 -j DROP')
    expect(next.trimEnd().endsWith('COMMIT')).toBe(true)
  })

  it('停用时移除规则段并回到原文', () => {
    expect(setScanEnabled(ENABLED_RULES, false)).toBe(BASE_RULES)
  })

  it('没有 COMMIT 行时报中文错误', () => {
    expect(() => setScanEnabled('-A foo\n', true)).toThrow('before.rules 格式无效')
  })
})

describe('parseRecentList', () => {
  it('解析内核 recent 名单的 src 条目', () => {
    const recent = `src=203.0.113.9 ttl: 64 last_seen: 5123456 oldest_pkt: 1 newest_pkt: 5123456
src=198.51.100.7 ttl: 63 last_seen: 5123400 oldest_pkt: 1 newest_pkt: 5123400
`
    expect(parseRecentList(recent)).toEqual(['203.0.113.9', '198.51.100.7'])
    expect(parseRecentList('')).toEqual([])
  })
})

describe('parseDropCounter', () => {
  it('从 iptables -nvx 输出取防扫描 DROP 规则的包计数', () => {
    expect(parseDropCounter(IPTABLES_LIST)).toBe(17)
  })

  it('找不到规则时返回 0', () => {
    expect(parseDropCounter('Chain ufw-before-input\n')).toBe(0)
  })
})

describe('validateUnblockIp', () => {
  it('接受合法 IP，拒绝网段与垃圾输入', () => {
    expect(validateUnblockIp(' 203.0.113.9 ')).toBe('203.0.113.9')
    expect(() => validateUnblockIp('203.0.113.0/24')).toThrow('IP 无效')
    expect(() => validateUnblockIp('example')).toThrow('IP 无效')
  })
})
