import { describe, expect, it } from 'vitest'
import { DEFAULT_SCAN_CONFIG } from '@elysian/contracts'
import {
  SCAN_BANNED6_RECENT_PATH,
  SCAN_BANNED_RECENT_PATH,
  SCAN_TABLES,
  parseDropCounter,
  parseRecentList,
  parseScanSection,
  scanSectionLines,
  setScanSection,
  validateUnblockIp,
} from './scanRules'

const BASE_RULES = `*filter
:ufw-before-input - [0:0]
-A ufw-before-input -i lo -j ACCEPT
-A ufw-before-input -p icmp --icmp-type echo-request -j ACCEPT
COMMIT`

const IPTABLES_LIST = `Chain ufw-before-input (1 references)
    pkts      bytes target     prot opt in     out     source               destination
     512    30720 ACCEPT     all  --  lo     *       0.0.0.0/0            0.0.0.0/0
       3      180 DROP       tcp  --  *      *       0.0.0.0/0            0.0.0.0/0           multiport dports 22 recent: CHECK seconds: 3600 name: ELYSIAN_SCAN_BANNED
      14      840 DROP       tcp  --  *      *       0.0.0.0/0            0.0.0.0/0           multiport dports 22 recent: CHECK seconds: 60 hit_count: 8 name: ELYSIAN_SCAN
      20     1200            tcp  --  *      *       0.0.0.0/0            0.0.0.0/0           multiport dports 22 recent: SET name: ELYSIAN_SCAN`

describe('parseScanSection', () => {
  it('规则段缺失为停用，配置回落默认', () => {
    const state = parseScanSection(BASE_RULES)
    expect(state.enabled).toBe(false)
    expect(state.config).toEqual(DEFAULT_SCAN_CONFIG)
  })

  it('从规则文本解析回配置（端口、窗口、阈值、封禁时长）', () => {
    const enabled = setScanSection(BASE_RULES, true, { ports: [22, 8080], windowSeconds: 120, hitCount: 5, banSeconds: 1800 })
    const state = parseScanSection(enabled)
    expect(state.enabled).toBe(true)
    expect(state.config).toEqual({ ports: [22, 8080], windowSeconds: 120, hitCount: 5, banSeconds: 1800 })
  })

  it('v6 规则段用独立链与名单名', () => {
    const v6 = setScanSection(BASE_RULES, true, DEFAULT_SCAN_CONFIG, 'v6')
    expect(v6).toContain(`-A ${SCAN_TABLES.v6.chain} `)
    expect(v6).toContain(`--name ${SCAN_TABLES.v6.track} --set`)
    expect(v6).toContain(`--name ${SCAN_TABLES.v6.banned} --rcheck`)
  })
})

describe('setScanSection', () => {
  it('启用插入双 DROP 的 jail 三行，停用回到原文', () => {
    const enabled = setScanSection(BASE_RULES, true)
    expect(enabled).toContain('--rcheck --seconds 60 --hitcount 8')
    expect(enabled).toContain('--set -j DROP')
    expect(enabled).toContain('--name ELYSIAN_SCAN --set')
    expect(enabled.trimEnd().endsWith('COMMIT')).toBe(true)
    expect(setScanSection(enabled, false)).toBe(BASE_RULES)
  })

  it('配置越界抛中文错误', () => {
    expect(() => setScanSection(BASE_RULES, true, { ...DEFAULT_SCAN_CONFIG, windowSeconds: 5 })).toThrow('判定窗口无效')
    expect(() => setScanSection(BASE_RULES, true, { ...DEFAULT_SCAN_CONFIG, hitCount: 1 })).toThrow('阈值无效')
    expect(() => setScanSection(BASE_RULES, true, { ...DEFAULT_SCAN_CONFIG, banSeconds: 10 })).toThrow('封禁时长无效')
    expect(() => setScanSection(BASE_RULES, true, { ...DEFAULT_SCAN_CONFIG, ports: [] })).toThrow('监控端口无效')
  })

  it('端口超过内核 multiport 上限时拒绝', () => {
    const ports = Array.from({ length: 16 }, (_, i) => 10000 + i)
    expect(() => setScanSection(BASE_RULES, true, { ...DEFAULT_SCAN_CONFIG, ports })).toThrow('最多 15 个端口')
  })

  it('恰好 15 个端口可正常生成规则段', () => {
    const ports = Array.from({ length: 15 }, (_, i) => 10000 + i)
    const enabled = setScanSection(BASE_RULES, true, { ...DEFAULT_SCAN_CONFIG, ports })
    expect(enabled).toContain(`--dports ${ports.join(',')}`)
  })

  it('没有 COMMIT 行时报中文错误', () => {
    expect(() => setScanSection('-A foo\n', true)).toThrow('before.rules 格式无效')
  })

  it('scanSectionLines 导出 v4 双 DROP 三行', () => {
    const lines = scanSectionLines()
    expect(lines.filter((line) => line.includes('DROP'))).toHaveLength(2)
  })
})

describe('名单路径常量', () => {
  it('v4/v6 封锁名单指向各自的 recent 文件', () => {
    expect(SCAN_BANNED_RECENT_PATH).toBe(`/proc/net/xt_recent/${SCAN_TABLES.v4.banned}`)
    expect(SCAN_BANNED6_RECENT_PATH).toBe(`/proc/net/xt_recent/${SCAN_TABLES.v6.banned}`)
    expect(SCAN_TABLES.v4.banned).not.toBe(SCAN_TABLES.v6.banned)
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
  it('两条 DROP 规则（封禁期 + 触发阈值）计数求和', () => {
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
