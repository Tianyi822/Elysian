import { describe, expect, it } from 'vitest'
import { DEFAULT_SCAN_CONFIG } from '@elysian/contracts'
import {
  FIREWALL_LIMITS,
  PANEL_PORT,
  backupPathOf,
  createFirewallService,
  restoreIfNeeded,
  type FirewallHostDeps,
} from './firewallService'
import { InvalidRequestError } from '../shared/errors.ts'
import { canonicalId, ipCanonicalId } from './parseUfw'
import { parsePingBlocked } from './pingRules'
import { SCAN_BANNED6_RECENT_PATH, SCAN_BANNED_RECENT_PATH, SCAN_TABLES, parseScanSection, setScanSection } from './scanRules'
import { IP_FORWARD_PATH, forwardCommentOf, noteFromForwardComment, parseForwardSection, setForwardSection } from './forwardRules'

/*
 * 用 fake 依赖模拟容器内 ufw/iptables 的行为：命令只记录进调用账本并按规则变化内部状态，
 * 编排逻辑（保底规则、先建后删、禁 ping、防扫描、转发段、时间账本）据此断言。
 */

/** 取异步失败的抛出值：断言错误的类型与状态码（请求被拒 4xx / 系统失败 500）。 */
function caught(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => null,
    (error: unknown) => error,
  )
}

function createFakeDeps(seed: {
  active?: boolean
  ipv6?: string
  ufwConf?: string
  listeners?: string[]
  rules?: string[]
  beforeRules?: string
  /** 关闭「enable 重放 nat 段」的模拟。 */
  reapplyNatOnEnable?: boolean
} = {}) {
  const ufwCalls: string[][] = []
  let active = seed.active ?? false
  let added = seed.rules ?? []
  let beforeRulesV4 = seed.beforeRules ?? [
    '# before.rules',
    '*filter',
    ':ufw-before-input - [0:0]',
    '-A ufw-before-input -i lo -j ACCEPT',
    '-A ufw-before-input -p icmp --icmp-type echo-request -j ACCEPT',
    'COMMIT',
  ].join('\n')
  let beforeRulesV6 = [
    '# before6.rules',
    '*filter',
    ':ufw6-before-input - [0:0]',
    '-A ufw6-before-input -p ipv6-icmp --icmpv6-type echo-request -j ACCEPT',
    'COMMIT',
  ].join('\n')
  let recentListV4 = ''
  let recentListV6 = ''
  let dropCounterV4 = 0
  let dropCounterV6 = 0
  // recent 名单文件随规则装入而生（ufw reload 后才出现）。
  let recentExistsV4 = false
  let recentExistsV6 = false
  let ipForward = '0\n'
  /** 内核 nat 表里属于本面板的规则（含重复条目，测试重复累加用）。 */
  const natRules: Array<{
    chain: 'PREROUTING' | 'POSTROUTING'
    protocol: 'tcp' | 'udp'
    port: string
    targetHost: string
    targetPort: number
    note: string | null
  }> = []
  const defaultUfw = seed.ipv6 ?? 'IPV6=yes'
  const ufwConf = seed.ufwConf ?? 'ENABLED=no\n'
  const ssOut = (seed.listeners ?? [`tcp:${PANEL_PORT}`]).map((key) => {
    const [proto, port] = key.split(':')
    const state = proto === 'udp' ? 'UNCONN' : 'LISTEN'
    return `${state} 0 0 *:${port} *:*`.replace(state, `${proto} ${state}`)
  }).join('\n') + '\n'
  const fileWrites: Array<{ path: string; content: string }> = []
  /** 规则文件之外的落盘内容（备份文件等），按路径记录。 */
  const extraFiles = new Map<string, string>()

  const iptablesList = (counter: number, names: string[]) => [
    `Chain ufw-before-input (1 references)`,
    `    pkts      bytes target     prot opt in     out     source               destination`,
    `   512    30720 ACCEPT     all  --  lo     *       0.0.0.0/0            0.0.0.0/0`,
    ...names.map(
      (name) =>
        `  ${counter}     1020 DROP       tcp  --  *      *       0.0.0.0/0            0.0.0.0/0           multiport dports 22 recent: CHECK seconds: 60 hit_count: 8 name: ${name}`,
    ),
  ].join('\n')

  const deps: FirewallHostDeps = {
    async runUfw(args) {
      ufwCalls.push([...args])
      const [verb, ...rest] = args
      if (verb === 'status') {
        // 真实 ufw 只在激活时才打印 Logging/Default 行，未激活时输出只有 Status 一行。
        return active
          ? 'Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n'
          : 'Status: inactive\n'
      }
      if (verb === 'show') return `Added user rules:\n${added.map((line) => `ufw ${line}`).join('\n') || '(None)'}`
      if (verb === '--force' && rest[0] === 'enable') {
        // 与真实 ufw 一致：只有完整的 enable 会重放 before.rules（reload 不会）。
        active = true
        dropCounterV4 = 0
        dropCounterV6 = 0
        recentExistsV4 = beforeRulesV4.includes(SCAN_TABLES.v4.track)
        recentExistsV6 = beforeRulesV6.includes(SCAN_TABLES.v6.track)
        // enable 以 --noflush 追加 nat 段：模拟内核里出现重复条目，由服务层随后删净重建。
        if (seed.reapplyNatOnEnable !== false && beforeRulesV4.includes('*nat')) {
          const lines = beforeRulesV4.split('\n')
          for (const line of lines) {
            const dnat = /-A PREROUTING -p (tcp|udp) --dport (\S+) -m comment --comment "([^"]*)" -j DNAT --to-destination ([\d.]+):(\d+)/.exec(line)
            if (dnat) {
              natRules.push({
                chain: 'PREROUTING',
                protocol: dnat[1] as 'tcp' | 'udp',
                port: dnat[2] ?? '',
                targetHost: dnat[4] ?? '',
                targetPort: Number.parseInt(dnat[5] ?? '0', 10),
                note: noteFromForwardComment(dnat[3] ?? ''),
              })
              continue
            }
            const masq = /-A POSTROUTING -d ([\d.]+) -p (tcp|udp) --dport (\d+) -m comment --comment "([^"]*)" -j MASQUERADE/.exec(line)
            if (masq) {
              natRules.push({
                chain: 'POSTROUTING',
                protocol: masq[2] as 'tcp' | 'udp',
                port: '',
                targetHost: masq[1] ?? '',
                targetPort: Number.parseInt(masq[3] ?? '0', 10),
                note: noteFromForwardComment(masq[4] ?? ''),
              })
            }
          }
        }
        return ''
      }
      if (verb === '--force' && rest[0] === 'disable') {
        active = false
        return ''
      }
      if (verb === 'disable') {
        active = false
        return ''
      }
      if (verb === 'reload') {
        return ''
      }
      if (verb === 'allow' || verb === 'deny' || verb === 'limit') {
        // 与真实 ufw 一致：comment 以带引号的字面量进入 show added 输出。
        const commentIndex = args.indexOf('comment')
        const specPart = (commentIndex === -1 ? args : args.slice(0, commentIndex)).join(' ')
        const comment = commentIndex === -1 ? null : args.slice(commentIndex + 1).join(' ')
        added.push(comment ? `${specPart} comment '${comment}'` : specPart)
        return 'Rules updated'
      }
      if (verb === 'delete') {
        const spec = args.slice(1).join(' ')
        const before = added.length
        added = added.filter((line) => line !== spec && !line.startsWith(`${spec} comment `))
        if (added.length === before) throw new Error(`ERROR: 找不到规则 (${spec})`)
        return 'Rules updated'
      }
      throw new Error(`fake ufw 未实现的命令：${args.join(' ')}`)
    },
    async runIptables(args) {
      ufwCalls.push([`iptables:${args.join(' ')}`])
      // nat 表的 DNAT/MASQUERADE 列举与增删走单独状态，模拟内核里的本面板规则。
      if (args[0] === '-t' && args[1] === 'nat') {
        const chain = args[3] as 'PREROUTING' | 'POSTROUTING'
        const list = natRules.filter((rule) => rule.chain === chain)
        if (args[2] === '-L') {
          return [
            `Chain ${chain} (policy ACCEPT)`,
            'num  target     prot opt source               destination',
            ...list.map((rule, index) =>
              `${index + 1}    ${rule.chain === 'PREROUTING' ? 'DNAT' : 'MASQUERADE'}  ${rule.protocol}  --  0.0.0.0/0            0.0.0.0/0            ${rule.protocol} dpt:${rule.chain === 'PREROUTING' ? rule.port : rule.targetPort} /* ${forwardCommentOf(rule.note)} */ to:${rule.targetHost}:${rule.targetPort}`,
            ),
          ].join('\n')
        }
        if (args[2] === '-D') {
          const index = Number.parseInt(args[4] ?? '', 10) - 1
          const target = list[index]
          if (!target) throw new Error(`DELETE 失败：${chain} 行号 ${args[4]} 不存在`)
          natRules.splice(natRules.indexOf(target), 1)
          return ''
        }
        if (args[2] === '-A') {
          const rest = args.slice(4)
          const get = (flag: string) => rest[rest.indexOf(flag) + 1]
          natRules.push({
            chain,
            protocol: (get('-p') ?? 'tcp') as 'tcp' | 'udp',
            // PREROUTING 的外部端口；POSTROUTING 没有外部端口概念（dport 即目标端口）。
            port: chain === 'PREROUTING' ? (get('--dport') ?? '') : '',
            targetHost: chain === 'PREROUTING' ? (get('--to-destination') ?? ':').split(':')[0] ?? '' : (get('-d') ?? ''),
            targetPort:
              chain === 'PREROUTING'
                ? Number.parseInt((get('--to-destination') ?? ':0').split(':')[1] ?? '0', 10)
                : Number.parseInt(get('--dport') ?? '0', 10),
            note: noteFromForwardComment(get('--comment') ?? ''),
          })
          return ''
        }
      }
      // 与真实内核一致：ufw 停用时 ufw-* 链不存在，查询 filter 链报错（nat 表内建链始终存在）。
      if (!active) throw new Error('iptables: No chain/target/match by that name.')
      return iptablesList(dropCounterV4, [SCAN_TABLES.v4.banned, SCAN_TABLES.v4.track])
    },
    async runIp6tables(args) {
      ufwCalls.push([`ip6tables:${args.join(' ')}`])
      if (!active) throw new Error('ip6tables: No chain/target/match by that name.')
      return iptablesList(dropCounterV6, [
        SCAN_TABLES.v6.banned,
        SCAN_TABLES.v6.track,
      ])
    },
    async runSs() {
      return ssOut
    },
    async readText(path) {
      if (path === '/etc/default/ufw') return defaultUfw
      if (path === '/etc/ufw/before.rules') return beforeRulesV4
      if (path === '/etc/ufw/before6.rules') return beforeRulesV6
      if (path === '/etc/ufw/ufw.conf') return ufwConf
      if (path === SCAN_BANNED_RECENT_PATH) {
        if (!recentExistsV4) throw new Error('ENOENT')
        return recentListV4
      }
      if (path === SCAN_BANNED6_RECENT_PATH) {
        if (!recentExistsV6) throw new Error('ENOENT')
        return recentListV6
      }
      if (path === IP_FORWARD_PATH) return ipForward
      if (extraFiles.has(path)) return extraFiles.get(path)!
      throw new Error(`fake 未实现的读取：${path}`)
    },
    async writeText(path, content) {
      fileWrites.push({ path, content })
      if (path === '/etc/ufw/before.rules') {
        beforeRulesV4 = content
        recentExistsV4 = recentExistsV4 || content.includes(SCAN_TABLES.v4.track)
      }
      if (path === '/etc/ufw/before6.rules') {
        beforeRulesV6 = content
        recentExistsV6 = recentExistsV6 || content.includes(SCAN_TABLES.v6.track)
      }
      if (path === IP_FORWARD_PATH) ipForward = content
      if (path === SCAN_BANNED_RECENT_PATH) {
        // 模拟内核 recent 名单的解封协议：「-IP」移除条目。
        const target = content.trim().replace(/^-/, '')
        recentListV4 = recentListV4
          .split('\n')
          .filter((line) => line && !line.startsWith(`src=${target} `))
          .join('\n')
      }
      if (path === SCAN_BANNED6_RECENT_PATH) {
        const target = content.trim().replace(/^-/, '')
        recentListV6 = recentListV6
          .split('\n')
          .filter((line) => line && !line.startsWith(`src=${target} `))
          .join('\n')
      }
      extraFiles.set(path, content)
    },
    async exists(path) {
      if (path === SCAN_BANNED_RECENT_PATH) return recentExistsV4
      if (path === SCAN_BANNED6_RECENT_PATH) return recentExistsV6
      if (extraFiles.has(path)) return true
      return true
    },
    nowIso: () => '2026-09-19T08:00:00.000Z',
    paths: {
      defaultUfw: '/etc/default/ufw',
      beforeRules: '/etc/ufw/before.rules',
      beforeRulesV6: '/etc/ufw/before6.rules',
      ufwConf: '/etc/ufw/ufw.conf',
    },
  }

  return {
    deps,
    ufwCalls,
    fileWrites,
    getAdded: () => [...added],
    isActive: () => active,
    getBeforeRules: () => beforeRulesV4,
    getBeforeRulesV6: () => beforeRulesV6,
    getForward: () => ipForward,
    getNatRules: () => natRules.map((rule) => ({ ...rule })),
    getFile: (path: string) => extraFiles.get(path),
    setFile: (path: string, content: string) => {
      extraFiles.set(path, content)
    },
    setRecent: (value: string, family: 'v4' | 'v6' = 'v4') => {
      if (family === 'v4') {
        recentListV4 = value
        recentExistsV4 = true
      } else {
        recentListV6 = value
        recentExistsV6 = true
      }
    },
    setDropCount: (value: number, family: 'v4' | 'v6' = 'v4') => {
      if (family === 'v4') dropCounterV4 = value
      else dropCounterV6 = value
    },
  }
}

const ALLOW_INPUT = {
  protocol: 'tcp' as const,
  port: 8080,
  family: 'ipv4' as const,
  policy: 'allow' as const,
  direction: 'inbound' as const,
  source: '所有IP',
  note: 'Web',
}

describe('createFirewallService list', () => {
  it('从 ufw 状态构建开关、默认策略与规则行，监听决定使用状态', async () => {
    const fake = createFakeDeps({
      active: true,
      rules: ['allow 22/tcp', `allow ${PANEL_PORT}/tcp comment 'Elysian 面板'`],
      listeners: [`tcp:${PANEL_PORT}`],
    })
    const service = createFirewallService(fake.deps)

    const [toggles, rules] = await Promise.all([service.toggles(), service.list()])
    expect(toggles).toEqual({
      firewallEnabled: true,
      pingBlocked: false,
      defaultIncoming: 'deny',
      defaultOutgoing: 'allow',
    })
    expect(rules).toHaveLength(4) // 每条规则 v4+v6 两行
    const panelRow = rules.find((rule) => rule.port === PANEL_PORT && rule.family === 'ipv4')
    expect(panelRow).toMatchObject({ status: 'normal', note: 'Elysian 面板', updatedAt: null })
    const sshRow = rules.find((rule) => rule.port === 22)
    expect(sshRow).toMatchObject({ status: 'unused', source: '所有IP' })
  })

  it('命令行手敲的 IP 规则也能读回（面板可见可删）', async () => {
    const fake = createFakeDeps({ active: true, rules: ['deny from 203.0.113.9'] })
    const service = createFirewallService(fake.deps)

    const [ipRules, rules] = await Promise.all([service.listIpRules(), service.list()])
    expect(rules).toHaveLength(0)
    expect(ipRules).toHaveLength(1)
    expect(ipRules[0]).toMatchObject({ source: '203.0.113.9', family: 'ipv4', policy: 'deny' })
  })
})

describe('createFirewallService create', () => {
  it('执行 ufw 命令并登记变更时间（会话账本与持久化账本都写）', async () => {
    const fake = createFakeDeps()
    const touched: Array<[string, string]> = []
    const deps = {
      ...fake.deps,
      ruleTimes: {
        get: () => undefined,
        set: (id: string, at: string) => touched.push([id, at]),
        remove: () => undefined,
      },
    }
    const service = createFirewallService(deps)

    const rule = await service.create(ALLOW_INPUT)
    expect(fake.ufwCalls[2]).toEqual(['allow', '8080/tcp', 'comment', 'Web'])
    expect(rule).toMatchObject({ port: 8080, note: 'Web', updatedAt: '2026-09-19T08:00:00.000Z' })
    expect(touched).toEqual([[canonicalId({ action: 'allow', direction: 'in', proto: 'tcp', port: '8080', from: 'any' }), '2026-09-19T08:00:00.000Z']])
  })

  it('持久化账本里的时间也参与读取（存量规则不丢时间）', async () => {
    const fake = createFakeDeps({ rules: ['allow 8080/tcp'] })
    const id = canonicalId({ action: 'allow', direction: 'in', proto: 'tcp', port: '8080', from: 'any' })
    const service = createFirewallService({
      ...fake.deps,
      ruleTimes: { get: (key: string) => (key === id ? '2026-01-02T03:04:05.000Z' : undefined), set: () => undefined, remove: () => undefined },
    })

    const rules = await service.list()
    expect(rules[0]?.updatedAt).toBe('2026-01-02T03:04:05.000Z')
  })

  it('同协议同端口视为重复并抛中文错误，不执行任何写命令', async () => {
    const fake = createFakeDeps({ rules: ['allow 8080/tcp'] })
    const service = createFirewallService(fake.deps)

    await expect(service.create(ALLOW_INPUT)).rejects.toThrow('端口规则已存在')
    expect(fake.ufwCalls.filter((args) => ['allow', 'deny', 'limit', 'delete'].includes(args[0] ?? ''))).toHaveLength(0)
  })

  it('重复判定按请求被拒（409）抛出，且不把输入的地址族说成已存在的规则', async () => {
    const fake = createFakeDeps({ rules: ['allow 22/tcp'] })
    const service = createFirewallService(fake.deps)

    const error = await service
      .create({ ...ALLOW_INPUT, port: 22, family: 'ipv6' })
      .catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(InvalidRequestError)
    expect((error as InvalidRequestError).status).toBe(409)
    // ufw 的端口规则对 IPv4/IPv6 一条覆盖两端：报错讲清语义，而不是宣称存在一条看不见的 ipv6 规则。
    expect((error as Error).message).not.toContain('（ipv6）')
    expect((error as Error).message).toContain('IPv4 与 IPv6 由同一条规则覆盖')
  })

  it('端口段与出站方向透传到 ufw 参数', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)

    await service.create({ ...ALLOW_INPUT, port: 1000, portTo: 2000, direction: 'outbound', policy: 'limit' })
    expect(fake.ufwCalls[2]).toEqual(['limit', 'out', '1000:2000/tcp', 'comment', 'Web'])
  })

  it('端口规则累计上限 200 条：超限拒绝且不执行写命令', async () => {
    const rules = Array.from({ length: FIREWALL_LIMITS.userRules }, (_, i) => `allow ${20000 + i}/tcp`)
    const fake = createFakeDeps({ rules })
    const service = createFirewallService(fake.deps)

    await expect(service.create(ALLOW_INPUT)).rejects.toThrow(`端口规则已达上限（最多 ${FIREWALL_LIMITS.userRules} 条）`)
    expect(fake.ufwCalls.filter((args) => ['allow', 'deny', 'limit', 'delete'].includes(args[0] ?? ''))).toHaveLength(0)
  })

  it('导入按去重后的真实新增数预估总量：将超上限整批拒绝，恰好在上限内可导入', async () => {
    const full = Array.from({ length: FIREWALL_LIMITS.userRules }, (_, i) => `allow ${20000 + i}/tcp`)
    const fake = createFakeDeps({ rules: full })
    const service = createFirewallService(fake.deps)

    // 两条输入批内去重后只新增 1 条：200 + 1 超限，整批拒绝
    await expect(
      service.importRules([{ ...ALLOW_INPUT, port: 3306, note: null }, { ...ALLOW_INPUT, port: 3306 }]),
    ).rejects.toThrow(`端口规则数将超出上限（最多 ${FIREWALL_LIMITS.userRules} 条）`)
    expect(fake.ufwCalls.filter((args) => ['allow', 'deny', 'limit', 'delete'].includes(args[0] ?? ''))).toHaveLength(0)

    // 199 + 1 恰好到上限：允许导入
    const nearlyFull = Array.from({ length: FIREWALL_LIMITS.userRules - 1 }, (_, i) => `allow ${20000 + i}/tcp`)
    const fake2 = createFakeDeps({ rules: nearlyFull })
    const service2 = createFirewallService(fake2.deps)
    const result = await service2.importRules([{ ...ALLOW_INPUT, port: 3306, note: 'MySQL' }])
    expect(result.added).toHaveLength(1)
    expect(result.skipped).toBe(0)
  })
})

describe('createFirewallService remove', () => {
  it('按规范指纹删除规则', async () => {
    const fake = createFakeDeps({ rules: ['allow 8080/tcp'] })
    const service = createFirewallService(fake.deps)

    await service.remove(`${canonicalId({ action: 'allow', direction: 'in', proto: 'tcp', port: '8080', from: 'any' })}.ipv4`)
    expect(fake.ufwCalls[2]).toEqual(['delete', 'allow', '8080/tcp'])
    expect(fake.getAdded()).toHaveLength(0)
  })

  it('面板端口保底规则不允许删除', async () => {
    const fake = createFakeDeps({ rules: [`allow ${PANEL_PORT}/tcp comment 'Elysian 面板'`] })
    const service = createFirewallService(fake.deps)

    const panelId = `${canonicalId({ action: 'allow', direction: 'in', proto: 'tcp', port: String(PANEL_PORT), from: 'any' })}.ipv4`
    await expect(service.remove(panelId)).rejects.toThrow('面板端口规则不允许删除')
    expect(fake.ufwCalls.every((args) => args[0] !== 'delete')).toBe(true)
  })
})

describe('createFirewallService update', () => {
  it('改端口时先建后删，失败时旧规则保留', async () => {
    const fake = createFakeDeps({ rules: ['allow 8080/tcp'] })
    const service = createFirewallService(fake.deps)
    const ruleId = `${canonicalId({ action: 'allow', direction: 'in', proto: 'tcp', port: '8080', from: 'any' })}.ipv4`

    await service.update(ruleId, { ...ALLOW_INPUT, port: 9090, note: null })
    expect(fake.ufwCalls[2]).toEqual(['allow', '9090/tcp'])
    expect(fake.ufwCalls[3]).toEqual(['delete', 'allow', '8080/tcp'])
    expect(fake.getAdded()).toEqual(['allow 9090/tcp'])
  })

  it('只改备注时先删后建（同规范规则不允许并存）', async () => {
    const fake = createFakeDeps({ rules: [`allow 8080/tcp comment '旧备注'`] })
    const service = createFirewallService(fake.deps)
    const ruleId = `${canonicalId({ action: 'allow', direction: 'in', proto: 'tcp', port: '8080', from: 'any' })}.ipv6`

    const rule = await service.update(ruleId, { ...ALLOW_INPUT, note: '新备注' })
    expect(fake.ufwCalls[2]).toEqual(['delete', 'allow', '8080/tcp'])
    expect(fake.ufwCalls[3]).toEqual(['allow', '8080/tcp', 'comment', '新备注'])
    expect(rule.note).toBe('新备注')
  })

  it('面板端口保底规则改成 deny 被拒绝，不执行任何写命令', async () => {
    const fake = createFakeDeps({ rules: [`allow ${PANEL_PORT}/tcp comment 'Elysian 面板'`] })
    const service = createFirewallService(fake.deps)
    const panelId = `${canonicalId({ action: 'allow', direction: 'in', proto: 'tcp', port: String(PANEL_PORT), from: 'any' })}.ipv4`

    await expect(
      service.update(panelId, { ...ALLOW_INPUT, port: PANEL_PORT, policy: 'deny', note: null }),
    ).rejects.toThrow('面板端口规则不允许变更')
    expect(fake.ufwCalls.filter((args) => ['allow', 'deny', 'limit', 'delete'].includes(args[0] ?? ''))).toHaveLength(0)
    expect(fake.getAdded()).toEqual([`allow ${PANEL_PORT}/tcp comment 'Elysian 面板'`])
  })

  it('面板保底规则等价规范的原地更新（只改备注）仍放行', async () => {
    const fake = createFakeDeps({ rules: [`allow ${PANEL_PORT}/tcp comment 'Elysian 面板'`] })
    const service = createFirewallService(fake.deps)
    const panelId = `${canonicalId({ action: 'allow', direction: 'in', proto: 'tcp', port: String(PANEL_PORT), from: 'any' })}.ipv4`

    const rule = await service.update(panelId, { ...ALLOW_INPUT, port: PANEL_PORT, note: '面板保底' })
    expect(fake.ufwCalls[2]).toEqual(['delete', 'allow', `${PANEL_PORT}/tcp`])
    expect(fake.ufwCalls[3]).toEqual(['allow', `${PANEL_PORT}/tcp`, 'comment', '面板保底'])
    expect(rule.note).toBe('面板保底')
  })
})

describe('createFirewallService importRules', () => {
  it('批内与既有规则去重，跳过数如实返回', async () => {
    const fake = createFakeDeps({ rules: ['allow 8080/tcp'] })
    const service = createFirewallService(fake.deps)

    const result = await service.importRules([
      ALLOW_INPUT,
      { ...ALLOW_INPUT, port: 3306, note: 'MySQL' },
      { ...ALLOW_INPUT, port: 3306 },
    ])
    expect(result.added).toHaveLength(1)
    expect(result.added[0]).toMatchObject({ port: 3306, note: 'MySQL' })
    expect(result.skipped).toBe(2)
  })

  it('整批先校验：任何一条非法则整批拒绝并报出第几条，合法条目也不执行', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)

    await expect(
      service.importRules([
        ALLOW_INPUT,
        { ...ALLOW_INPUT, port: 0 },
        { ...ALLOW_INPUT, port: 9090, note: null },
      ]),
    ).rejects.toThrow('第 2 条规则无效')
    expect(fake.ufwCalls.filter((args) => ['allow', 'deny', 'limit', 'delete'].includes(args[0] ?? ''))).toHaveLength(0)
  })

  it('执行阶段中途失败：报出第几条与已写入条数，界面据此同步真实状态', async () => {
    const fake = createFakeDeps()
    const originalRunUfw = fake.deps.runUfw
    let writes = 0
    fake.deps.runUfw = async (args) => {
      if (['allow', 'deny', 'limit'].includes(args[0] ?? '')) {
        writes += 1
        if (writes === 2) throw new Error('ERROR: 规则写入失败')
      }
      return originalRunUfw(args)
    }
    const service = createFirewallService(fake.deps)

    const error = await service
      .importRules([
        { ...ALLOW_INPUT, port: 8080 },
        { ...ALLOW_INPUT, port: 9090, note: null },
        { ...ALLOW_INPUT, port: 9091, note: null },
      ])
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('第 2 条规则写入失败')
    expect(message).toContain('此前 1 条已写入防火墙')
    // 消息里的条数与防火墙里的真实状态一致：第 1 条确实已写入，重新同步即可看到
    expect(fake.getAdded()).toEqual([`allow 8080/tcp comment 'Web'`])
  })
})

describe('createFirewallService IP 规则', () => {
  it('创建执行 allow/deny from 并回读', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)

    const rule = await service.createIpRule({ policy: 'deny', source: '203.0.113.0/24', note: '恶意扫描段' })
    expect(fake.ufwCalls[2]).toEqual(['deny', 'from', '203.0.113.0/24', 'comment', '恶意扫描段'])
    expect(rule).toMatchObject({ source: '203.0.113.0/24', family: 'ipv4', policy: 'deny' })
  })

  it('重复来源报中文错误；v6 来源归 ipv6 地址族', async () => {
    const fake = createFakeDeps({ rules: ['deny from 203.0.113.9'] })
    const service = createFirewallService(fake.deps)

    await expect(service.createIpRule({ policy: 'deny', source: '203.0.113.9', note: null })).rejects.toThrow('IP 规则已存在')
    const v6 = await service.createIpRule({ policy: 'allow', source: 'fd00::/8', note: null })
    expect(v6.family).toBe('ipv6')
  })

  it('IP 规则累计上限 200 条：超限拒绝且不执行写命令', async () => {
    const rules = Array.from({ length: FIREWALL_LIMITS.ipRules }, (_, i) => `deny from 198.18.0.${i}`)
    const fake = createFakeDeps({ rules })
    const service = createFirewallService(fake.deps)

    await expect(service.createIpRule({ policy: 'deny', source: '203.0.113.9', note: null })).rejects.toThrow(
      `IP 规则已达上限（最多 ${FIREWALL_LIMITS.ipRules} 条）`,
    )
    expect(fake.ufwCalls.filter((args) => ['allow', 'deny', 'limit', 'delete'].includes(args[0] ?? ''))).toHaveLength(0)
  })

  it('修改与删除按指纹操作', async () => {
    const fake = createFakeDeps({ rules: [`deny from 203.0.113.9 comment '旧'`] })
    const service = createFirewallService(fake.deps)
    const id = `${ipCanonicalId({ action: 'deny', direction: 'in', from: '203.0.113.9' })}.ipv4`

    await service.removeIpRule(id)
    expect(fake.getAdded()).toHaveLength(0)

    fake.setRecent('')
    await service.createIpRule({ policy: 'allow', source: '10.0.0.0/8', note: null })
    const id2 = `${ipCanonicalId({ action: 'allow', direction: 'in', from: '10.0.0.0/8' })}.ipv4`
    const updated = await service.updateIpRule(id2, { policy: 'deny', source: '10.0.0.0/8', note: '改拒绝' })
    expect(updated.policy).toBe('deny')
  })
})

describe('createFirewallService 端口转发', () => {
  it('创建写入 *nat 标记段（置于文件最前）并精确落到内核', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)

    const rule = await service.createForward({
      protocol: 'tcp',
      port: 8080,
      targetHost: '10.0.0.5',
      targetPort: 80,
      note: '博客内网上游',
    })
    expect(rule).toMatchObject({ port: 8080, portTo: null, targetHost: '10.0.0.5', targetPort: 80 })

    const written = fake.fileWrites.find((write) => write.path === '/etc/ufw/before.rules')
    expect(written?.content.startsWith('### ELYSIAN 端口转发')).toBe(true)
    expect(written?.content).toContain('*nat')
    expect(parseForwardSection(written?.content ?? '')).toHaveLength(1)
    // ufw 默认转发策略是 DROP：DNAT 之外还要在 ufw-before-forward 里精确放行
    expect(written?.content).toContain('-A ufw-before-forward -p tcp -d 10.0.0.5 --dport 80')
    // 内核里成对出现：PREROUTING 的 DNAT + POSTROUTING 的 MASQUERADE
    expect(fake.getNatRules()).toEqual([
      { chain: 'PREROUTING', protocol: 'tcp', port: '8080', targetHost: '10.0.0.5', targetPort: 80, note: '博客内网上游' },
      { chain: 'POSTROUTING', protocol: 'tcp', port: '', targetHost: '10.0.0.5', targetPort: 80, note: '博客内网上游' },
    ])
    // 放行段要经完整的 disable→enable 周期生效
    expect(fake.ufwCalls.some((args) => args[0] === '--force' && args[1] === 'enable')).toBe(true)
  })

  it('重复应用不会累加内核规则（先删净再重建）', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)

    const rule = await service.createForward({ protocol: 'tcp', port: 8080, targetHost: '10.0.0.5', targetPort: 80, note: null })
    await service.updateForward(rule.id, { protocol: 'tcp', port: 8080, targetHost: '10.0.0.9', targetPort: 80, note: null })
    expect(fake.getNatRules()).toEqual([
      { chain: 'PREROUTING', protocol: 'tcp', port: '8080', targetHost: '10.0.0.9', targetPort: 80, note: null },
      { chain: 'POSTROUTING', protocol: 'tcp', port: '', targetHost: '10.0.0.9', targetPort: 80, note: null },
    ])
  })

  it('外部端口冲突报中文错误；目标地址非法按请求被拒（400）报中文错误', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)
    await service.createForward({ protocol: 'tcp', port: 8080, targetHost: '10.0.0.5', targetPort: 80, note: null })

    await expect(
      service.createForward({ protocol: 'tcp', port: 8080, targetHost: '10.0.0.6', targetPort: 81, note: null }),
    ).rejects.toThrow('端口转发已存在')
    await expect(
      service.createForward({ protocol: 'tcp', port: 9090, targetHost: 'fd00::1', targetPort: 80, note: null }),
    ).rejects.toThrow('目标地址无效')

    // 目标是 CIDR 网段同样拒绝：会写出 iptables-restore 装载失败的坏规则。
    // 这是请求体本身的问题，端点据此返回 400（不是 500），也不动内核。
    const natBefore = fake.getNatRules().length
    const denied = await caught(
      service.createForward({ protocol: 'tcp', port: 9090, targetHost: '10.0.0.0/24', targetPort: 80, note: null }),
    )
    expect(denied).toBeInstanceOf(InvalidRequestError)
    expect((denied as InvalidRequestError).status).toBe(400)
    expect((denied as Error).message).toBe('目标地址无效：10.0.0.0/24（应为单个 IPv4 地址，不含网段）')
    expect(fake.getNatRules()).toHaveLength(natBefore)
  })

  it('冲突检测按端口区间重叠判断：区间存在时单端口与相交区间都判冲突', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)
    await service.createForward({ protocol: 'tcp', port: 1000, portTo: 2000, targetHost: '10.0.0.5', targetPort: 80, note: null })

    // 单端口落入既有区间：后建者会静默失效，判冲突
    await expect(
      service.createForward({ protocol: 'tcp', port: 1500, targetHost: '10.0.0.9', targetPort: 81, note: null }),
    ).rejects.toThrow('端口转发已存在')
    // 区间端点重叠
    await expect(
      service.createForward({ protocol: 'tcp', port: 2000, portTo: 3000, targetHost: '10.0.0.9', targetPort: 81, note: null }),
    ).rejects.toThrow('端口转发已存在')
    // 协议不同或区间不相交：允许
    await service.createForward({ protocol: 'udp', port: 1500, targetHost: '10.0.0.9', targetPort: 81, note: null })
    await service.createForward({ protocol: 'tcp', port: 2001, portTo: 3000, targetHost: '10.0.0.9', targetPort: 81, note: null })
    expect(parseForwardSection(fake.getBeforeRules())).toHaveLength(3)
  })

  it('面板端口不允许配置转发：单端口与覆盖区间都在服务端被拒（400），不写文件不动内核', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)

    const denied = await caught(
      service.createForward({ protocol: 'tcp', port: PANEL_PORT, targetHost: '10.0.0.5', targetPort: 8080, note: null }),
    )
    expect(denied).toBeInstanceOf(InvalidRequestError)
    expect((denied as InvalidRequestError).status).toBe(400)
    expect((denied as Error).message).toBe(
      `面板端口不允许配置转发：外部端口段覆盖 ${PANEL_PORT}（工作台自身的访问通道）`,
    )

    await expect(
      service.createForward({ protocol: 'tcp', port: 1000, portTo: PANEL_PORT + 1, targetHost: '10.0.0.5', targetPort: 80, note: null }),
    ).rejects.toThrow('面板端口不允许配置转发')
    await expect(
      service.createForward({ protocol: 'tcp', port: 1000, portTo: PANEL_PORT + 1, targetHost: '10.0.0.5', targetPort: 80, note: null }),
    ).rejects.toThrow('面板端口不允许配置转发')
    expect(fake.fileWrites.filter((write) => write.path === '/etc/ufw/before.rules')).toHaveLength(0)
    expect(fake.getNatRules()).toHaveLength(0)
  })

  it('更新转发到覆盖面板端口的区间同样被拒', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)
    const rule = await service.createForward({ protocol: 'tcp', port: 8080, targetHost: '10.0.0.5', targetPort: 80, note: null })

    await expect(
      service.updateForward(rule.id, { protocol: 'tcp', port: 5000, portTo: PANEL_PORT + 1, targetHost: '10.0.0.5', targetPort: 80, note: null }),
    ).rejects.toThrow('面板端口不允许配置转发')
  })

  it('端口转发累计上限 32 条：超限拒绝且段与内核都不变', async () => {
    const specs = Array.from({ length: FIREWALL_LIMITS.forwards }, (_, i) => ({
      protocol: 'tcp' as const,
      port: String(20000 + i),
      targetHost: '10.0.0.5',
      targetPort: 80,
      note: null,
    }))
    const fake = createFakeDeps({ beforeRules: setForwardSection(createFakeDeps().getBeforeRules(), specs) })
    const service = createFirewallService(fake.deps)

    await expect(
      service.createForward({ protocol: 'tcp', port: 30000, targetHost: '10.0.0.5', targetPort: 80, note: null }),
    ).rejects.toThrow(`端口转发已达上限（最多 ${FIREWALL_LIMITS.forwards} 条）`)
    expect(parseForwardSection(fake.getBeforeRules())).toHaveLength(FIREWALL_LIMITS.forwards)
  })

  it('删除最后一条转发时清空段与内核规则', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)
    const rule = await service.createForward({ protocol: 'udp', port: 53, targetHost: '10.0.0.53', targetPort: 53, note: null })

    await service.removeForward(rule.id)
    expect(parseForwardSection(fake.getBeforeRules())).toHaveLength(0)
    expect(fake.getNatRules()).toHaveLength(0)
  })

  it('更新替换同一条规范而不是新增', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)
    const rule = await service.createForward({ protocol: 'tcp', port: 8080, targetHost: '10.0.0.5', targetPort: 80, note: null })

    const updated = await service.updateForward(rule.id, {
      protocol: 'tcp',
      port: 8080,
      targetHost: '10.0.0.9',
      targetPort: 8080,
      note: '换目标',
    })
    expect(updated.targetHost).toBe('10.0.0.9')
    expect(parseForwardSection(fake.getBeforeRules())).toHaveLength(1)
  })

  it('应用规则文件（disable→enable）后内核 nat 不累加，转发段仍在文件里', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)
    await service.createForward({ protocol: 'tcp', port: 8080, targetHost: '10.0.0.5', targetPort: 80, note: null })
    expect(fake.getNatRules().filter((r) => r.chain === 'PREROUTING')).toHaveLength(1)

    // 防扫描配置变更会走一轮完整重启；enable 会把文件里的 nat 段再追加一次
    await service.setScanProtection(true)
    expect(fake.ufwCalls.filter((args) => args[0] === '--force' && args[1] === 'enable').length).toBeGreaterThanOrEqual(2)

    // 服务层在 enable 后删净重建：内核里仍只有一条，文件里的段也完好
    expect(fake.getNatRules().filter((r) => r.chain === 'PREROUTING')).toHaveLength(1)
    expect(parseForwardSection(fake.getBeforeRules())).toHaveLength(1)
    expect(fake.isActive()).toBe(true)
  })

  it('enable 后防火墙未激活时报中文错误并说明现状与恢复方式（备份恢复重试仍失败）', async () => {
    const fake = createFakeDeps({ active: true })
    const deps = { ...fake.deps }
    const original = deps.runUfw
    deps.runUfw = async (args) => {
      if (args[0] === '--force' && args[1] === 'enable') {
        // 模拟坏规则文件：ufw 的 enable 没有把防火墙拉起来
        return ''
      }
      return original(args)
    }
    const service = createFirewallService(deps)

    const error = await service.setScanProtection(true).then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('规则重载后防火墙未处于激活状态')
    expect(message).toContain('备份')
    expect(message).toContain('ufw enable')
  })
})

describe('createFirewallService setToggles', () => {
  it('启用前自动补面板保底规则，再 force enable', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)

    const toggles = await service.setToggles({
      firewallEnabled: true,
      pingBlocked: false,
      defaultIncoming: 'deny',
      defaultOutgoing: 'allow',
    })
    expect(toggles.firewallEnabled).toBe(true)
    const enableIndex = fake.ufwCalls.findIndex((args) => args[0] === '--force')
    expect(enableIndex).toBeGreaterThan(-1)
    expect(fake.ufwCalls[enableIndex! - 1]).toEqual(['allow', `${PANEL_PORT}/tcp`, 'comment', 'Elysian 面板'])
    expect(fake.isActive()).toBe(true)
  })

  it('关闭后回读不再报错：ufw 未激活时不打印 Default 行，默认策略读作未知', async () => {
    const fake = createFakeDeps({
      active: true,
      rules: [`allow ${PANEL_PORT}/tcp comment 'Elysian 面板'`],
    })
    const service = createFirewallService(fake.deps)

    const toggles = await service.setToggles({
      firewallEnabled: false,
      pingBlocked: false,
      defaultIncoming: 'deny',
      defaultOutgoing: 'allow',
    })

    expect(toggles.firewallEnabled).toBe(false)
    expect(toggles.defaultIncoming).toBeNull()
    expect(toggles.defaultOutgoing).toBeNull()
  })

  it('未激活时 toggles() 也能读：面板加载不该因缺 Default 行而失败', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)

    await expect(service.toggles()).resolves.toMatchObject({
      firewallEnabled: false,
      defaultIncoming: null,
      defaultOutgoing: null,
    })
  })

  it('启用时保底规则已存在则不重复添加', async () => {
    const fake = createFakeDeps({ rules: [`allow ${PANEL_PORT}/tcp comment 'Elysian 面板'`] })
    const service = createFirewallService(fake.deps)

    await service.setToggles({ firewallEnabled: true, pingBlocked: false, defaultIncoming: 'deny', defaultOutgoing: 'allow' })
    expect(fake.ufwCalls.filter((args) => args[0] === 'allow')).toHaveLength(0)
  })

  it('禁 ping 改写 v4/v6 before.rules 并经完整重启生效', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)

    await service.setToggles({ firewallEnabled: true, pingBlocked: true, defaultIncoming: 'deny', defaultOutgoing: 'allow' })
    expect(fake.getBeforeRules()).toContain('--icmp-type echo-request -j DROP')
    expect(fake.getBeforeRulesV6()).toContain('--icmpv6-type echo-request -j DROP')
    expect(fake.ufwCalls.some((args) => args[0] === '--force' && args[1] === 'enable')).toBe(true)
    expect(fake.isActive()).toBe(true)
  })

  it('未激活时切禁 ping 只写文件不 reload', async () => {
    const fake = createFakeDeps({ active: false })
    const service = createFirewallService(fake.deps)

    await service.setToggles({ firewallEnabled: false, pingBlocked: true, defaultIncoming: 'deny', defaultOutgoing: 'allow' })
    expect(fake.ufwCalls.filter((args) => args[0] === 'reload')).toHaveLength(0)
  })

  it('停用执行 ufw disable', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)

    await service.setToggles({ firewallEnabled: false, pingBlocked: false, defaultIncoming: 'deny', defaultOutgoing: 'allow' })
    expect(fake.ufwCalls).toContainEqual(['disable'])
    expect(fake.isActive()).toBe(false)
  })
})

describe('createFirewallService 防扫描', () => {
  it('停用态返回 enabled=false 与零统计', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)

    const scan = await service.scanProtection()
    expect(scan.enabled).toBe(false)
    expect(scan.config).toEqual(DEFAULT_SCAN_CONFIG)
    expect(scan.stats).toEqual({ totalBlockedIps: 0, totalFailedConnections: 0, currentBlockedIps: 0, currentFailedConnections: 0 })
    expect(scan.blocked).toEqual([])
  })

  it('开启时双栈写规则段并在激活时 reload，快照从零起算', async () => {
    const fake = createFakeDeps({ active: true })
    fake.setDropCount(100)
    const service = createFirewallService(fake.deps)

    const scan = await service.setScanProtection(true)
    expect(scan.enabled).toBe(true)
    const v4Write = fake.fileWrites.find((write) => write.path === '/etc/ufw/before.rules')
    const v6Write = fake.fileWrites.find((write) => write.path === '/etc/ufw/before6.rules')
    expect(v4Write && parseScanSection(v4Write.content).enabled).toBe(true)
    expect(v6Write?.content).toContain(SCAN_TABLES.v6.track)
    expect(fake.ufwCalls.some((args) => args[0] === '--force' && args[1] === 'enable')).toBe(true)
    expect(scan.stats.currentFailedConnections).toBe(0)
  })

  it('配置可保存：端口/窗口/阈值/封禁时长写进规则并从文本解析回', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)
    await service.setScanProtection(true)

    const scan = await service.setScanConfig({ ports: [22, 8080], windowSeconds: 120, hitCount: 5, banSeconds: 1800 })
    expect(scan.config).toEqual({ ports: [22, 8080], windowSeconds: 120, hitCount: 5, banSeconds: 1800 })
    const written = fake.fileWrites.filter((write) => write.path === '/etc/ufw/before.rules').at(-1)
    expect(written?.content).toContain('--dports 22,8080')
    expect(written?.content).toContain('--hitcount 5')
    expect(written?.content).toContain('--seconds 1800')
  })

  it('配置越界按请求被拒（400），未开启保存按前置状态不满足（409），中文错误各自明确', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)

    // 未开启：配置本身没被质疑，只是开关没开 → 409，界面据此提示先开开关而不是「请求写错了」
    const disabled = await caught(service.setScanConfig({ ...DEFAULT_SCAN_CONFIG }))
    expect(disabled).toBeInstanceOf(InvalidRequestError)
    expect((disabled as InvalidRequestError).status).toBe(409)
    expect((disabled as Error).message).toBe('防扫描未启用：先开启开关再调整配置')

    await service.setScanProtection(true)
    const invalid = await caught(service.setScanConfig({ ...DEFAULT_SCAN_CONFIG, hitCount: 1 }))
    expect(invalid).toBeInstanceOf(InvalidRequestError)
    expect((invalid as InvalidRequestError).status).toBe(400)
    expect((invalid as Error).message).toContain('阈值无效')
  })

  it('监控端口包含面板端口时保存被拒绝（400）：DROP 先于保底放行，会封掉面板客户端且解封端点不可达', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)
    await service.setScanProtection(true)

    const denied = await caught(service.setScanConfig({ ...DEFAULT_SCAN_CONFIG, ports: [22, PANEL_PORT] }))
    expect(denied).toBeInstanceOf(InvalidRequestError)
    expect((denied as InvalidRequestError).status).toBe(400)
    expect((denied as Error).message).toBe(
      `面板端口不允许加入防扫描监控：${PANEL_PORT} 是工作台自身的访问通道`,
    )
    // 配置未被写入：段里的端口仍是默认值
    expect(parseScanSection(fake.getBeforeRules()).config.ports).toEqual([...DEFAULT_SCAN_CONFIG.ports])
  })

  it('停用态提交含面板端口的配置：先按请求体拒绝（400），不是「未启用」的 409', async () => {
    const fake = createFakeDeps({ active: false })
    const service = createFirewallService(fake.deps)

    // 校验是纯函数、先于开关状态：面板端口这条保底判据在停用态同样拦得住
    const denied = await caught(service.setScanConfig({ ...DEFAULT_SCAN_CONFIG, ports: [22, PANEL_PORT] }))
    expect(denied).toBeInstanceOf(InvalidRequestError)
    expect((denied as InvalidRequestError).status).toBe(400)
    expect((denied as Error).message).toContain('面板端口不允许加入防扫描监控')
    // 拒绝不落盘：文件里没有扫描段
    expect(parseScanSection(fake.getBeforeRules()).enabled).toBe(false)
  })

  it('停用态读防扫描不查 iptables：规则段在文件里也只回报配置与空统计，读路径不 500', async () => {
    // fake 的 iptables 在停用态模拟 ufw 链不存在（对齐真实内核）：一旦被查询就抛错
    const scanEnabledBefore = setScanSection(createFakeDeps().getBeforeRules(), true)
    const fake = createFakeDeps({ active: false, beforeRules: scanEnabledBefore })
    const service = createFirewallService(fake.deps)

    const scan = await service.scanProtection()
    expect(scan.enabled).toBe(true)
    expect(scan.stats).toEqual({ totalBlockedIps: 0, totalFailedConnections: 0, currentBlockedIps: 0, currentFailedConnections: 0 })
    expect(scan.blocked).toEqual([])
    expect(fake.ufwCalls.some((args) => args[0]?.startsWith('iptables:') || args[0]?.startsWith('ip6tables:'))).toBe(false)
  })

  it('停用态开启防扫描仍写文件、不 reload，读取回报空统计（防火墙启用后生效）', async () => {
    const fake = createFakeDeps({ active: false })
    const service = createFirewallService(fake.deps)

    const scan = await service.setScanProtection(true)
    expect(parseScanSection(fake.getBeforeRules()).enabled).toBe(true)
    expect(fake.ufwCalls.some((args) => args[0] === '--force' && args[1] === 'enable')).toBe(false)
    expect(scan.enabled).toBe(true)
    expect(scan.stats.currentBlockedIps).toBe(0)
    expect(scan.stats.currentFailedConnections).toBe(0)
  })

  it('写规则文件前先把当前内容备份到 .elysian 后缀文件', async () => {
    const fake = createFakeDeps({ active: false })
    const service = createFirewallService(fake.deps)
    const originalV4 = fake.getBeforeRules()
    const originalV6 = fake.getBeforeRulesV6()

    await service.setScanProtection(true)
    expect(fake.getFile(backupPathOf('/etc/ufw/before.rules'))).toBe(originalV4)
    expect(fake.getFile(backupPathOf('/etc/ufw/before6.rules'))).toBe(originalV6)
    const backupWrite = fake.fileWrites.find((write) => write.path === backupPathOf('/etc/ufw/before.rules'))
    expect(backupWrite?.content).toBe(originalV4)
  })

  it('enable 拉不起防火墙时先用备份恢复规则文件再重试：恢复成功按失败报出，本次变更已回滚', async () => {
    const fake = createFakeDeps({ active: true })
    const originalRunUfw = fake.deps.runUfw
    fake.deps.runUfw = async (args) => {
      if (args[0] === '--force' && args[1] === 'enable' && fake.getBeforeRules().includes(SCAN_TABLES.v4.track)) {
        // 模拟坏规则文件：enable 没有把防火墙拉起来；恢复到备份（无扫描段）后可正常拉起
        return ''
      }
      return originalRunUfw(args)
    }
    const service = createFirewallService(fake.deps)

    const error = await service.setScanProtection(true).then(
      () => null,
      (caught: unknown) => caught,
    )
    // 恢复成功不等于本次变更成功：防火墙此刻跑的是恢复后的旧规则，必须按失败报出。
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('规则重载未生效')
    expect(message).toContain('已被回滚')
    expect(message).toContain('备份')

    expect(fake.isActive()).toBe(true)
    // 坏写入已回滚到备份内容：文件里的防扫描段被移除，读取如实回报停用
    expect(parseScanSection(fake.getBeforeRules()).enabled).toBe(false)
    expect((await service.scanProtection()).enabled).toBe(false)
  })

  it('禁 ping 变更遇上恢复回滚时同样按失败抛出，界面不会把旧规则说成已生效', async () => {
    const fake = createFakeDeps({ active: true })
    const originalRunUfw = fake.deps.runUfw
    fake.deps.runUfw = async (args) => {
      // 只在「已写入禁 ping 的新规则文件」上失败：恢复到备份（未禁 ping）后可拉起
      if (args[0] === '--force' && args[1] === 'enable' && parsePingBlocked(fake.getBeforeRules())) {
        return ''
      }
      return originalRunUfw(args)
    }
    const service = createFirewallService(fake.deps)
    const before = fake.getBeforeRules()

    const error = await service
      .setToggles({
        firewallEnabled: true,
        pingBlocked: true,
        defaultIncoming: 'deny',
        defaultOutgoing: 'allow',
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('已被回滚')
    // 文件回到备份内容：禁 ping 的改动没有留在生效规则里
    expect(fake.getBeforeRules()).toBe(before)
    expect((await service.toggles()).pingBlocked).toBe(false)
  })

  it('启用后从 v4/v6 recent 名单与 DROP 计数器汇总真实统计', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)
    await service.setScanProtection(true)
    fake.setDropCount(40, 'v4')
    fake.setDropCount(2, 'v6')
    fake.setRecent('src=203.0.113.9 ttl: 64 last_seen: 1 oldest_pkt: 1 newest_pkt: 1\n')
    fake.setRecent('src=2001:db8::9 ttl: 64 last_seen: 1 oldest_pkt: 1 newest_pkt: 1\n', 'v6')

    const scan = await service.scanProtection()
    expect(scan.enabled).toBe(true)
    // 双 DROP 规则 × 双栈：v4(40×2) + v6(2×2)
    expect(scan.stats.totalFailedConnections).toBe(84)
    expect(scan.stats.currentBlockedIps).toBe(2)
    expect(scan.blocked.map((entry) => entry.ip)).toEqual(['203.0.113.9', '2001:db8::9'])
    expect(scan.blocked[0]!.blockedAt).toBe('2026-09-19T08:00:00.000Z')

    // 再次观察同一批 IP 不重复累计历史总数
    fake.setRecent('src=203.0.113.9 ttl: 64 last_seen: 3 oldest_pkt: 1 newest_pkt: 3\n')
    fake.setRecent('', 'v6')
    const next = await service.scanProtection()
    expect(next.stats.totalBlockedIps).toBe(2)
    expect(next.blocked).toHaveLength(1)
  })

  it('解封按地址族写对应名单：v4 与 v6 各自生效', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)
    await service.setScanProtection(true)
    fake.setRecent('src=203.0.113.9 ttl: 64 last_seen: 1 oldest_pkt: 1 newest_pkt: 1\n')
    fake.setRecent('src=2001:db8::9 ttl: 64 last_seen: 1 oldest_pkt: 1 newest_pkt: 1\n', 'v6')

    const scan = await service.unblockIp('2001:db8::9')
    const v6Write = fake.fileWrites.find((write) => write.path === SCAN_BANNED6_RECENT_PATH)
    expect(v6Write?.content).toBe('-2001:db8::9\n')
    expect(scan.blocked.map((entry) => entry.ip)).toEqual(['203.0.113.9'])
  })

  it('解封不合法 IP 与未启用时都报中文错误', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)

    await expect(service.unblockIp('203.0.113.0/24')).rejects.toThrow('防扫描未启用')

    await service.setScanProtection(true)
    await expect(service.unblockIp('example')).rejects.toThrow('IP 无效')
    // 名单里没有的 IP：写「-IP」对内核没有意义，明确报错。
    fake.setRecent('src=203.0.113.9 ttl: 64 last_seen: 1 oldest_pkt: 1 newest_pkt: 1\n')
    await expect(service.unblockIp('198.51.100.7')).rejects.toThrow('不在封锁名单中')
  })

  it('停用时移除双栈规则段', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)

    await service.setScanProtection(true)
    const scan = await service.setScanProtection(false)
    expect(scan.enabled).toBe(false)
    expect(parseScanSection(fake.getBeforeRules()).enabled).toBe(false)
  })
})

describe('createFirewallService 规则文件串行队列', () => {
  it('并发变更排队执行：防扫描开启与转发创建互不覆盖，两段都留在文件里', async () => {
    const fake = createFakeDeps({ active: false })
    const originalWriteText = fake.deps.writeText
    fake.deps.writeText = async (path, content) => {
      if (path === '/etc/ufw/before.rules') {
        // 把落盘推迟一个宏任务放大交错窗口：没有互斥时，两个操作都在改动前的
        // 原文上计算新内容，后落盘者会整段覆盖掉先落盘者的变更
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      return originalWriteText(path, content)
    }
    const service = createFirewallService(fake.deps)

    await Promise.all([
      service.setScanProtection(true),
      service.createForward({ protocol: 'tcp', port: 8080, targetHost: '10.0.0.5', targetPort: 80, note: null }),
    ])

    const text = fake.getBeforeRules()
    expect(parseScanSection(text).enabled).toBe(true)
    expect(parseForwardSection(text)).toHaveLength(1)
  })

  it('并发改禁 ping 与删除转发同样排队：双方变更都不丢失', async () => {
    const fake = createFakeDeps({ active: true })
    const originalWriteText = fake.deps.writeText
    fake.deps.writeText = async (path, content) => {
      if (path === '/etc/ufw/before.rules') {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      return originalWriteText(path, content)
    }
    const service = createFirewallService(fake.deps)
    const rule = await service.createForward({ protocol: 'tcp', port: 8080, targetHost: '10.0.0.5', targetPort: 80, note: null })

    await Promise.all([
      service.setToggles({ firewallEnabled: true, pingBlocked: true, defaultIncoming: 'deny', defaultOutgoing: 'allow' }),
      service.removeForward(rule.id),
    ])

    const text = fake.getBeforeRules()
    expect(text).toContain('--icmp-type echo-request -j DROP')
    expect(parseForwardSection(text)).toHaveLength(0)
  })
})

describe('createFirewallService syncFromSystem', () => {
  it('返回端口/IP/转发三类规则行总数', async () => {
    const fake = createFakeDeps({ rules: ['allow 22/tcp', 'deny from 203.0.113.9'] })
    const service = createFirewallService(fake.deps)
    await service.createForward({ protocol: 'tcp', port: 8080, targetHost: '10.0.0.5', targetPort: 80, note: null })

    // 端口 2 行(22 v4/v6) + IP 1 行 + 转发 1 行
    await expect(service.syncFromSystem()).resolves.toEqual({ total: 4 })
  })
})

describe('restoreIfNeeded', () => {
  it('ufw.conf 记 ENABLED=yes 时补保底规则并装载', async () => {
    const fake = createFakeDeps({ ufwConf: 'ENABLED=yes\nLOGLEVEL=low\n' })

    await restoreIfNeeded(fake.deps)
    const enableIndex = fake.ufwCalls.findIndex((args) => args[0] === '--force')
    expect(enableIndex).toBeGreaterThan(-1)
    expect(fake.ufwCalls[enableIndex! - 1]).toEqual(['allow', `${PANEL_PORT}/tcp`, 'comment', 'Elysian 面板'])
  })

  it('ENABLED=no 与配置缺失时不动作', async () => {
    const noConf = createFakeDeps({ ufwConf: 'ENABLED=no\n' })
    await restoreIfNeeded(noConf.deps)
    expect(noConf.ufwCalls).toHaveLength(0)

    const missingConf = createFakeDeps()
    missingConf.deps.readText = async (path: string) => {
      if (path === '/etc/ufw/ufw.conf') throw new Error('ENOENT')
      return ''
    }
    await restoreIfNeeded(missingConf.deps)
    expect(missingConf.ufwCalls).toHaveLength(0)
  })

  it('启动装载失败时用备份恢复规则文件后再试一次', async () => {
    const corrupted = ['# 损坏的规则文件', '*filter', '-A 坏行'].join('\n')
    const clean = createFakeDeps().getBeforeRules()
    const fake = createFakeDeps({ active: false, ufwConf: 'ENABLED=yes\n', beforeRules: corrupted })
    fake.setFile(backupPathOf('/etc/ufw/before.rules'), clean)
    let enableCalls = 0
    const original = fake.deps.runUfw
    fake.deps.runUfw = async (args) => {
      if (args[0] === '--force' && args[1] === 'enable') {
        enableCalls += 1
        // 第一次 enable 因坏规则文件失败；恢复后第二次成功
        if (enableCalls === 1) throw new Error('ERROR: problem running ufw init')
      }
      return original(args)
    }

    await restoreIfNeeded(fake.deps)
    expect(enableCalls).toBe(2)
    expect(fake.getBeforeRules()).toBe(clean)
    expect(fake.isActive()).toBe(true)
  })
})
