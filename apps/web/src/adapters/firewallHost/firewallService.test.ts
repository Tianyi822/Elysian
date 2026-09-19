import { describe, expect, it } from 'vitest'
import {
  PANEL_PORT,
  createFirewallService,
  restoreIfNeeded,
  type FirewallHostDeps,
} from './firewallService'
import { canonicalId, ruleIdOf } from './parseUfw'
import { SCAN_CHAIN_NAME, SCAN_RECENT_PATH, parseScanEnabled, scanSectionLines } from './scanRules'

/*
 * 用 fake 依赖模拟容器内 ufw 的行为：命令只记录进调用账本并按规则变化内部状态，
 * 编排逻辑（保底规则、先建后删、禁 ping 文件切换、会话时间账本）据此断言。
 */

function createFakeDeps(seed: {
  active?: boolean
  ipv6?: string
  ufwConf?: string
  listeners?: string[]
  rules?: string[]
} = {}) {
  const ufwCalls: string[][] = []
  let active = seed.active ?? false
  let added = seed.rules ?? []
  let beforeRulesV4 = [
    '# before.rules',
    '-A ufw-before-input -i lo -j ACCEPT',
    '-A ufw-before-input -p icmp --icmp-type echo-request -j ACCEPT',
    'COMMIT',
  ].join('\n')
  let beforeRulesV6 = [
    '# before6.rules',
    '-A ufw6-before-input -p ipv6-icmp --icmpv6-type echo-request -j ACCEPT',
  ].join('\n')
  let recentList = ''
  let dropCounterPackets = 0
  // recent 名单文件随规则装入而生（ufw reload 后才出现）。
  let recentExists = false
  const defaultUfw = seed.ipv6 ?? 'IPV6=yes'
  const ufwConf = seed.ufwConf ?? 'ENABLED=no\n'
  const ssOut = (seed.listeners ?? ['tcp:5173']).map((key) => {
    const [proto, port] = key.split(':')
    const state = proto === 'udp' ? 'UNCONN' : 'LISTEN'
    return `${state} 0 0 *:${port} *:*`.replace(state, `${proto} ${state}`)
  }).join('\n') + '\n'
  const fileWrites: Array<{ path: string; content: string }> = []

  const deps: FirewallHostDeps = {
    async runUfw(args) {
      ufwCalls.push([...args])
      const [verb, ...rest] = args
      if (verb === 'status') return `Status: ${active ? 'active' : 'inactive'}\n`
      if (verb === 'show') return `Added user rules:\n${added.map((line) => `ufw ${line}`).join('\n') || '(None)'}`
      if (verb === '--force' && rest[0] === 'enable') {
        active = true
        return ''
      }
      if (verb === 'disable') {
        active = false
        return ''
      }
      if (verb === 'reload') {
        // 规则重装后内核计数器从零开始。
        dropCounterPackets = 0
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
      const list = [
        `Chain ufw-before-input (1 references)`,
        `pkts      bytes target     prot opt in     out     source               destination`,
        `   512    30720 ACCEPT     all  --  lo     *       0.0.0.0/0            0.0.0.0/0`,
        `  ${dropCounterPackets}     1020 DROP       tcp  --  *      *       0.0.0.0/0            0.0.0.0/0           multiport dports 22 recent: CHECK seconds: 60 hit_count: 8 name: ${SCAN_CHAIN_NAME}`,
      ].join('\n')
      void args
      return list
    },
    async runSs() {
      return ssOut
    },
    async readText(path) {
      if (path === '/etc/default/ufw') return defaultUfw
      if (path === '/etc/ufw/before.rules') return beforeRulesV4
      if (path === '/etc/ufw/before6.rules') return beforeRulesV6
      if (path === '/etc/ufw/ufw.conf') return ufwConf
      if (path === SCAN_RECENT_PATH) {
        if (!recentExists) throw new Error('ENOENT')
        return recentList
      }
      throw new Error(`fake 未实现的读取：${path}`)
    },
    async writeText(path, content) {
      fileWrites.push({ path, content })
      if (path === '/etc/ufw/before.rules') {
        beforeRulesV4 = content
        recentExists = content.includes(SCAN_CHAIN_NAME)
      }
      if (path === '/etc/ufw/before6.rules') beforeRulesV6 = content
      if (path === SCAN_RECENT_PATH) {
        // 模拟内核 recent 名单的解封协议：「-IP」移除条目。
        const target = content.trim().replace(/^-/, '')
        recentList = recentList
          .split('\n')
          .filter((line) => line && !line.startsWith(`src=${target} `))
          .join('\n')
      }
    },
    async exists(path) {
      if (path === SCAN_RECENT_PATH) return recentExists
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

  return { deps, ufwCalls, fileWrites, getAdded: () => [...added], isActive: () => active, setRecent: (value: string) => { recentList = value }, setDropCount: (value: number) => { dropCounterPackets = value } }
}

function panelRuleId(family: 'ipv4' | 'ipv6' = 'ipv4'): string {
  return ruleIdOf(
    { action: 'allow', direction: 'in', proto: 'tcp', port: String(PANEL_PORT), from: 'any' },
    family,
  )
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
  it('从 ufw 状态构建开关与规则行，监听决定使用状态', async () => {
    const fake = createFakeDeps({
      active: true,
      rules: ['allow 22/tcp', `allow ${PANEL_PORT}/tcp comment 'Elysian 面板'`],
      listeners: ['tcp:5173'],
    })
    const service = createFirewallService(fake.deps)

    const [toggles, rules] = await Promise.all([service.toggles(), service.list()])
    expect(toggles).toEqual({ firewallEnabled: true, pingBlocked: false })
    expect(rules).toHaveLength(4) // 每条规则 v4+v6 两行
    const panelRow = rules.find((rule) => rule.port === PANEL_PORT && rule.family === 'ipv4')
    expect(panelRow).toMatchObject({ status: 'normal', note: 'Elysian 面板', updatedAt: null })
    const sshRow = rules.find((rule) => rule.port === 22)
    expect(sshRow).toMatchObject({ status: 'unused', source: '所有IP' })
  })
})

describe('createFirewallService create', () => {
  it('执行 ufw 命令并登记会话时间', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)

    const rule = await service.create(ALLOW_INPUT)
    // readState（status + show added）之后执行添加命令。
    expect(fake.ufwCalls[2]).toEqual(['allow', '8080/tcp', 'comment', 'Web'])
    expect(rule).toMatchObject({ port: 8080, note: 'Web', updatedAt: '2026-09-19T08:00:00.000Z' })
  })

  it('同协议同端口视为重复并抛中文错误，不执行任何写命令', async () => {
    const fake = createFakeDeps({ rules: ['allow 8080/tcp'] })
    const service = createFirewallService(fake.deps)

    await expect(service.create(ALLOW_INPUT)).rejects.toThrow('端口规则已存在')
    expect(fake.ufwCalls.filter((args) => ['allow', 'deny', 'limit', 'delete'].includes(args[0] ?? ''))).toHaveLength(0)
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

    await expect(service.remove(panelRuleId())).rejects.toThrow('面板端口规则不允许删除')
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
})

describe('createFirewallService setToggles', () => {
  it('启用前自动补面板保底规则，再 force enable', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)

    const toggles = await service.setToggles({ firewallEnabled: true, pingBlocked: false })
    expect(toggles).toEqual({ firewallEnabled: true, pingBlocked: false })
    const enableIndex = fake.ufwCalls.findIndex((args) => args[0] === '--force')
    expect(enableIndex).toBeGreaterThan(-1)
    expect(fake.ufwCalls[enableIndex! - 1]).toEqual(['allow', `${PANEL_PORT}/tcp`, 'comment', 'Elysian 面板'])
    expect(fake.isActive()).toBe(true)
  })

  it('启用时保底规则已存在则不重复添加', async () => {
    const fake = createFakeDeps({ rules: [`allow ${PANEL_PORT}/tcp comment 'Elysian 面板'`] })
    const service = createFirewallService(fake.deps)

    await service.setToggles({ firewallEnabled: true, pingBlocked: false })
    expect(fake.ufwCalls.filter((args) => args[0] === 'allow')).toHaveLength(0)
  })

  it('禁 ping 改写 v4/v6 before.rules 并在激活时 reload', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)

    await service.setToggles({ firewallEnabled: true, pingBlocked: true })
    expect(fake.fileWrites).toHaveLength(2)
    expect(fake.fileWrites[0]!.content).toContain('--icmp-type echo-request -j DROP')
    expect(fake.fileWrites[1]!.content).toContain('--icmpv6-type echo-request -j DROP')
    expect(fake.ufwCalls.at(-1)).toEqual(['reload'])
  })

  it('未激活时切禁 ping 只写文件不 reload', async () => {
    const fake = createFakeDeps({ active: false })
    const service = createFirewallService(fake.deps)

    await service.setToggles({ firewallEnabled: false, pingBlocked: true })
    expect(fake.fileWrites).toHaveLength(2)
    expect(fake.ufwCalls.filter((args) => args[0] === 'reload')).toHaveLength(0)
  })

  it('停用执行 ufw disable', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)

    await service.setToggles({ firewallEnabled: false, pingBlocked: false })
    expect(fake.ufwCalls).toContainEqual(['disable'])
    expect(fake.isActive()).toBe(false)
  })
})

describe('createFirewallService syncFromSystem', () => {
  it('返回系统侧规则行总数', async () => {
    const fake = createFakeDeps({ rules: ['allow 22/tcp'] })
    const service = createFirewallService(fake.deps)

    await expect(service.syncFromSystem()).resolves.toEqual({ total: 2 })
  })
})

describe('createFirewallService 防扫描', () => {
  it('停用态返回 enabled=false 与零统计', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)

    const scan = await service.scanProtection()
    expect(scan.enabled).toBe(false)
    expect(scan.stats).toEqual({ totalBlockedIps: 0, totalFailedConnections: 0, currentBlockedIps: 0, currentFailedConnections: 0 })
    expect(scan.blocked).toEqual([])
  })

  it('开启时写规则段并在激活时 reload，快照从零起算', async () => {
    const fake = createFakeDeps({ active: true })
    fake.setDropCount(100)
    const service = createFirewallService(fake.deps)

    const scan = await service.setScanProtection(true)
    const rulesWrite = fake.fileWrites.find((write) => write.path === '/etc/ufw/before.rules')
    expect(rulesWrite && parseScanEnabled(rulesWrite.content)).toBe(true)
    expect(scan.enabled).toBe(true)
    expect(fake.ufwCalls.filter((args) => args[0] === 'reload')).toHaveLength(1)
    expect(scan.stats.currentFailedConnections).toBe(0)
  })

  it('启用后从 recent 名单与 DROP 计数器汇总真实统计', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)
    await service.setScanProtection(true)
    fake.setDropCount(42)
    fake.setRecent('src=203.0.113.9 ttl: 64 last_seen: 1 oldest_pkt: 1 newest_pkt: 1\nsrc=198.51.100.7 ttl: 63 last_seen: 2 oldest_pkt: 1 newest_pkt: 2\n')

    const scan = await service.scanProtection()
    expect(scan.enabled).toBe(true)
    expect(scan.stats).toEqual({
      totalBlockedIps: 2,
      totalFailedConnections: 42,
      currentBlockedIps: 2,
      currentFailedConnections: 42,
    })
    expect(scan.blocked.map((entry) => entry.ip)).toEqual(['203.0.113.9', '198.51.100.7'])
    expect(scan.blocked[0]!.blockedAt).toBe('2026-09-19T08:00:00.000Z')

    // 再次观察同一批 IP 不重复累计历史总数
    fake.setRecent('src=203.0.113.9 ttl: 64 last_seen: 3 oldest_pkt: 1 newest_pkt: 3\n')
    const next = await service.scanProtection()
    expect(next.stats.totalBlockedIps).toBe(2)
    expect(next.blocked).toHaveLength(1)
  })

  it('解封向 recent 名单写入「-IP」', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)
    await service.setScanProtection(true)
    fake.setRecent('src=203.0.113.9 ttl: 64 last_seen: 1 oldest_pkt: 1 newest_pkt: 1\n')

    const scan = await service.unblockIp('203.0.113.9')
    const unblockWrite = fake.fileWrites.find((write) => write.path === SCAN_RECENT_PATH)
    expect(unblockWrite?.content).toBe('-203.0.113.9\n')
    expect(scan.blocked).toEqual([])
  })

  it('解封不合法 IP 与未启用时都报中文错误', async () => {
    const fake = createFakeDeps()
    const service = createFirewallService(fake.deps)

    await expect(service.unblockIp('203.0.113.0/24')).rejects.toThrow('防扫描未启用')

    await service.setScanProtection(true)
    await expect(service.unblockIp('example')).rejects.toThrow('IP 无效')
  })

  it('停用时移除规则段', async () => {
    const fake = createFakeDeps({ active: true })
    const service = createFirewallService(fake.deps)

    await service.setScanProtection(true)
    const scan = await service.setScanProtection(false)
    expect(scan.enabled).toBe(false)
    expect(scanSectionLines().every((line) => !fake.fileWrites.at(-1)!.content.includes(line))).toBe(true)
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
    missingConf.deps.readText = async (path) => {
      if (path === '/etc/ufw/ufw.conf') throw new Error('ENOENT')
      return ''
    }
    await restoreIfNeeded(missingConf.deps)
    expect(missingConf.ufwCalls).toHaveLength(0)
  })
})
