import type {
  FirewallRule,
  FirewallRuleInput,
  FirewallScanProtection,
  FirewallToggles,
} from '@elysian/contracts'
import type { FirewallAdapter } from '../../contracts/adapters'
import {
  canonicalId,
  displayPortOf,
  parseIpv6Enabled,
  parseRuleId,
  parseShowAdded,
  parseStatusVerbose,
  ruleRowsFromSpec,
  specFromInput,
  specToArgs,
  type ParsedUfwLine,
  type UfwRuleSpec,
} from './parseUfw'
import { parseSsListening } from './parseSockets'
import { parsePingBlocked, setPingBlocked } from './pingRules'
import {
  SCAN_RECENT_PATH,
  parseDropCounter,
  parseRecentList,
  parseScanEnabled,
  setScanEnabled,
  validateUnblockIp,
} from './scanRules'

/*
 * 防火墙面板的服务编排：把界面动作翻译成容器内 ufw 的真实命令。
 * 全部系统访问经 deps 注入，编排逻辑在 Vitest 里用 fake 依赖驱动。
 *
 * 防锁死保底：面板端口（5173/tcp）在启用防火墙前自动放行，且不允许经面板删除；
 * 容器没有 systemd，ufw.conf 记 ENABLED=yes 时由 restoreIfNeeded 在 dev server
 * 启动时重新装载，等价真实服务器的 ufw.service 开机自启。
 */

export const PANEL_PORT = 5173

const PANEL_SPEC: UfwRuleSpec = {
  action: 'allow',
  direction: 'in',
  proto: 'tcp',
  port: String(PANEL_PORT),
  from: 'any',
}
const PANEL_CANONICAL = canonicalId(PANEL_SPEC)

export const DEFAULT_FIREWALL_PATHS = {
  defaultUfw: '/etc/default/ufw',
  beforeRules: '/etc/ufw/before.rules',
  beforeRulesV6: '/etc/ufw/before6.rules',
  ufwConf: '/etc/ufw/ufw.conf',
}

export type FirewallHostDeps = {
  /** 执行 ufw 子命令，返回 stdout；失败抛错（含 stderr）。 */
  runUfw(args: readonly string[]): Promise<string>
  /** `ss -Hultn` 输出。 */
  runSs(): Promise<string>
  /** 读取 iptables 规则与计数（`iptables -L <chain> -nvx`）。 */
  runIptables(args: readonly string[]): Promise<string>
  readText(path: string): Promise<string>
  writeText(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  nowIso(): string
  paths?: typeof DEFAULT_FIREWALL_PATHS
}

type HostState = {
  active: boolean
  ipv6Enabled: boolean
  pingBlocked: boolean
  lines: readonly ParsedUfwLine[]
  listeners: ReadonlySet<string>
}

/** 面板端口保底规则若不存在则补上（带备注「Elysian 面板」）。 */
export async function ensurePanelRule(deps: FirewallHostDeps): Promise<void> {
  const stdout = await deps.runUfw(['show', 'added'])
  const exists = parseShowAdded(stdout).some(
    (line) => canonicalId(line.spec) === PANEL_CANONICAL,
  )
  if (!exists) {
    await deps.runUfw(['allow', `${PANEL_PORT}/tcp`, 'comment', 'Elysian 面板'])
  }
}

export function createFirewallService(deps: FirewallHostDeps): FirewallAdapter {
  const paths = deps.paths ?? DEFAULT_FIREWALL_PATHS
  /** 本会话内经面板变更过的规则（规范指纹 → ISO 时间）；dev server 重启后清空，存量规则回到「—」。 */
  const updatedAtMap = new Map<string, string>()
  /** 防扫描会话统计：历史封锁过的 IP 与其首次观察时间，dev server 重启后清零。 */
  const scanSeenIps = new Set<string>()
  const scanFirstSeenAt = new Map<string, string>()
  /** 防扫描开启时刻的 DROP 计数快照，「当前连接失败次数」= 累计值 − 快照。 */
  let scanDropSnapshot = 0

  async function runUfw(args: readonly string[]): Promise<string> {
    try {
      return await deps.runUfw(args)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`ufw 执行失败（${args.join(' ')}）：${detail}`)
    }
  }

  async function readState(): Promise<HostState> {
    const [verbose, added, defaultUfw, ssOut, beforeRules] = await Promise.all([
      runUfw(['status', 'verbose']),
      runUfw(['show', 'added']),
      deps.readText(paths.defaultUfw),
      deps.runSs(),
      deps.readText(paths.beforeRules),
    ])
    return {
      active: parseStatusVerbose(verbose).active,
      ipv6Enabled: parseIpv6Enabled(defaultUfw),
      pingBlocked: parsePingBlocked(beforeRules),
      lines: parseShowAdded(added),
      listeners: parseSsListening(ssOut),
    }
  }

  function rowContext(state: HostState) {
    return {
      ipv6Enabled: state.ipv6Enabled,
      listeners: state.listeners,
      updatedAtMap,
    }
  }

  function rulesOf(state: HostState): readonly FirewallRule[] {
    return state.lines.flatMap((line) => ruleRowsFromSpec(line.spec, line.comment, rowContext(state)))
  }

  /** 与演示数据同一唯一性语义：同协议同端口（按显示端口）只允许一条规则。 */
  function findDuplicate(state: HostState, input: FirewallRuleInput, exceptCanonical?: string): ParsedUfwLine | undefined {
    return state.lines.find(
      (line) =>
        canonicalId(line.spec) !== exceptCanonical &&
        line.spec.proto === input.protocol &&
        displayPortOf(line.spec) === input.port,
    )
  }

  function commentArgs(comment: string | null): readonly string[] {
    return comment ? ['comment', comment] : []
  }

  function togglesOf(state: HostState): FirewallToggles {
    return { firewallEnabled: state.active, pingBlocked: state.pingBlocked }
  }

  /** 汇总防扫描实时状态：名单来自内核 recent 文件，拦截计数来自 iptables 规则计数器。 */
  async function readScanProtection(): Promise<FirewallScanProtection> {
    const beforeRules = await deps.readText(paths.beforeRules)
    const enabled = parseScanEnabled(beforeRules)

    let ips: readonly string[] = []
    let dropCounter = 0
    if (enabled) {
      try {
        // 规则段已写入但 ufw 尚未 reload（或未激活）时，内核名单文件还不存在：视为空名单。
        if (await deps.exists(SCAN_RECENT_PATH)) {
          ips = parseRecentList(await deps.readText(SCAN_RECENT_PATH))
          dropCounter = parseDropCounter(await deps.runIptables(['-L', 'ufw-before-input', '-nvx']))
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`防扫描内核数据不可读：${detail}`)
      }
      for (const ip of ips) {
        if (!scanSeenIps.has(ip)) {
          scanSeenIps.add(ip)
          scanFirstSeenAt.set(ip, deps.nowIso())
        }
      }
    }

    return {
      enabled,
      stats: {
        totalBlockedIps: scanSeenIps.size,
        totalFailedConnections: dropCounter,
        currentBlockedIps: ips.length,
        currentFailedConnections: Math.max(0, dropCounter - scanDropSnapshot),
      },
      blocked: ips.map((ip) => ({
        ip,
        blockedAt: scanFirstSeenAt.get(ip) ?? deps.nowIso(),
      })),
    }
  }

  function firstRow(rows: readonly FirewallRule[]): FirewallRule {
    const row = rows[0]
    if (!row) throw new Error('规则行生成失败：没有可用地址族')
    return row
  }

  async function patchPing(blocked: boolean): Promise<void> {
    for (const path of [paths.beforeRules, paths.beforeRulesV6]) {
      if (!(await deps.exists(path))) continue
      const text = await deps.readText(path)
      await deps.writeText(path, setPingBlocked(text, blocked))
    }
  }

  return {
    async list() {
      const state = await readState()
      return rulesOf(state)
    },

    async toggles() {
      return togglesOf(await readState())
    },

    async setToggles(next) {
      const current = togglesOf(await readState())

      if (next.firewallEnabled !== current.firewallEnabled) {
        if (next.firewallEnabled) {
          await ensurePanelRule(deps)
          await runUfw(['--force', 'enable'])
        } else {
          await runUfw(['disable'])
        }
      }

      if (next.pingBlocked !== current.pingBlocked) {
        await patchPing(next.pingBlocked)
        // reload 只在防火墙激活时需要；未激活时文件改动会在下次 enable 生效。
        if (next.firewallEnabled) {
          await runUfw(['reload'])
        }
      }

      return { firewallEnabled: next.firewallEnabled, pingBlocked: next.pingBlocked }
    },

    async create(input) {
      const spec = specFromInput(input)
      const state = await readState()
      const duplicate = findDuplicate(state, input)
      if (duplicate) {
        throw new Error(`端口规则已存在：${input.protocol} ${input.port}（${input.family}）`)
      }
      await runUfw([...specToArgs(spec), ...commentArgs(input.note)])
      updatedAtMap.set(canonicalId(spec), deps.nowIso())
      return firstRow(ruleRowsFromSpec(spec, input.note, rowContext(await readState())))
    },

    async update(ruleId, input) {
      const parsed = parseRuleId(ruleId)
      if (!parsed) throw new Error(`无效的规则标识：${ruleId}`)
      const state = await readState()
      const oldCanonical = canonicalId(parsed.spec)
      const existing = state.lines.find((line) => canonicalId(line.spec) === oldCanonical)
      if (!existing) throw new Error(`未找到端口规则 ${ruleId}（可能已在系统侧变更，请先同步）`)

      const spec = specFromInput(input)
      const duplicate = findDuplicate(state, input, oldCanonical)
      if (duplicate) {
        throw new Error(`端口规则已存在：${input.protocol} ${input.port}（${input.family}）`)
      }
      const nextCanonical = canonicalId(spec)

      if (nextCanonical === oldCanonical) {
        // 只改备注：先删后建（同规范规则 ufw 不允许并存）。
        await runUfw(['delete', ...specToArgs(parsed.spec)])
        await runUfw([...specToArgs(spec), ...commentArgs(input.note)])
      } else {
        // 先建后删：新建失败时旧规则保持原样。
        await runUfw([...specToArgs(spec), ...commentArgs(input.note)])
        await runUfw(['delete', ...specToArgs(parsed.spec)])
      }
      updatedAtMap.delete(oldCanonical)
      updatedAtMap.set(nextCanonical, deps.nowIso())

      return firstRow(ruleRowsFromSpec(spec, input.note, rowContext(await readState())))
    },

    async remove(ruleId) {
      const parsed = parseRuleId(ruleId)
      if (!parsed) throw new Error(`无效的规则标识：${ruleId}`)
      if (canonicalId(parsed.spec) === PANEL_CANONICAL) {
        throw new Error('面板端口规则不允许删除：它是保证工作台可访问的保底规则')
      }
      const state = await readState()
      const exists = state.lines.some((line) => canonicalId(line.spec) === canonicalId(parsed.spec))
      if (!exists) throw new Error(`未找到端口规则 ${ruleId}（可能已在系统侧变更，请先同步）`)
      await runUfw(['delete', ...specToArgs(parsed.spec)])
      updatedAtMap.delete(canonicalId(parsed.spec))
    },

    async importRules(inputs) {
      const added: FirewallRule[] = []
      let skipped = 0
      for (const input of inputs) {
        const spec = specFromInput(input)
        const state = await readState()
        if (findDuplicate(state, input)) {
          skipped += 1
          continue
        }
        await runUfw([...specToArgs(spec), ...commentArgs(input.note)])
        updatedAtMap.set(canonicalId(spec), deps.nowIso())
        added.push(firstRow(ruleRowsFromSpec(spec, input.note, rowContext(await readState()))))
      }
      return { added, skipped }
    },

    async scanProtection(): Promise<FirewallScanProtection> {
      return readScanProtection()
    },

    async setScanProtection(enabled) {
      const beforeRules = await deps.readText(paths.beforeRules)
      await deps.writeText(paths.beforeRules, setScanEnabled(beforeRules, enabled))
      // 开启时刻重置快照，「当前连接失败次数」从零起算。
      if (enabled) scanDropSnapshot = 0
      const state = await readState()
      if (state.active) {
        await runUfw(['reload'])
      }
      return readScanProtection()
    },

    async unblockIp(ip) {
      const beforeRules = await deps.readText(paths.beforeRules)
      if (!parseScanEnabled(beforeRules)) {
        throw new Error('防扫描未启用：没有可解封的 IP')
      }
      const target = validateUnblockIp(ip)
      // 内核 recent 名单的解封协议：向名单文件写入「-IP」即移除该条目。
      await deps.writeText(SCAN_RECENT_PATH, `-${target}\n`)
      return readScanProtection()
    },

    async syncFromSystem() {
      const state = await readState()
      return { total: rulesOf(state).length }
    },
  }
}

/**
 * 容器没有 systemd：ufw.conf 记 ENABLED=yes 而内核规则已随上次容器停止消失，
 * dev server 启动时重新装载一次，等价真实服务器的 ufw.service 开机自启。
 */
export async function restoreIfNeeded(deps: FirewallHostDeps): Promise<void> {
  const paths = deps.paths ?? DEFAULT_FIREWALL_PATHS
  let conf: string
  try {
    conf = await deps.readText(paths.ufwConf)
  } catch {
    return
  }
  if (!/^ENABLED=yes$/m.test(conf)) return
  await ensurePanelRule(deps)
  await deps.runUfw(['--force', 'enable'])
}
