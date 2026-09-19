import type {
  FirewallForwardRule,
  FirewallIpRule,
  FirewallRule,
  FirewallRuleInput,
  FirewallScanConfig,
  FirewallScanProtection,
  FirewallToggles,
} from '@elysian/contracts'
import type { FirewallAdapter } from '../../contracts/adapters'
import {
  canonicalId,
  displayPortOf,
  ipCanonicalId,
  ipRuleRowFromSpec,
  ipSpecFromInput,
  ipSpecToArgs,
  parseIpRuleId,
  parseIpv6Enabled,
  parseRuleId,
  parseShowAdded,
  parseStatusVerbose,
  ruleRowsFromSpec,
  specFromInput,
  specToArgs,
  type IpUfwLine,
  type PortUfwLine,
  type RuleRowContext,
  type UfwRuleSpec,
} from './parseUfw'
import { parseSsListening } from './parseSockets'
import { parsePingBlocked, setPingBlocked } from './pingRules'
import {
  SCAN_BANNED6_RECENT_PATH,
  SCAN_BANNED_RECENT_PATH,
  parseDropCounter,
  parseRecentList,
  parseScanSection,
  setScanSection,
  validateUnblockIp,
} from './scanRules'
import {
  IP_FORWARD_PATH,
  forwardIdOf,
  forwardRowFromSpec,
  natRuleArgsOf,
  parseForwardId,
  parseForwardSection,
  parseOurNatRuleNumbers,
  postRoutingArgsOf,
  setForwardFilterSection,
  setForwardSection,
  specFromForwardInput,
  type ForwardSpec,
} from './forwardRules'
import type { FirewallRuleTimes } from './ruleTimesStore'

/*
 * 防火墙面板的服务编排：把界面动作翻译成容器内 ufw 的真实命令。
 * 全部系统访问经 deps 注入，编排逻辑在 Vitest 里用 fake 依赖驱动。
 *
 * 防锁死保底：面板端口（5173/tcp）在启用防火墙前自动放行，且不允许经面板删除；
 * 容器没有 systemd，ufw.conf 记 ENABLED=yes 时由 restoreIfNeeded 在 dev server
 * 启动时重新装载，等价真实服务器的 ufw.service 开机自启。
 *
 * 规则变更时间：会话账本优先，其次 SQLite 持久化账本（Docker 下挂命名卷），
 * 两处都没有的存量规则显示「—」。
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
  /** 读取 v4 iptables 规则与计数（`iptables -L <chain> -nvx`）。 */
  runIptables(args: readonly string[]): Promise<string>
  /** 读取 v6 iptables 规则与计数（`ip6tables -L <chain> -nvx`）。 */
  runIp6tables(args: readonly string[]): Promise<string>
  readText(path: string): Promise<string>
  writeText(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  nowIso(): string
  paths?: typeof DEFAULT_FIREWALL_PATHS
  /** 规则时间持久化账本；缺省只用会话账本（刷新后回到「—」）。 */
  ruleTimes?: Pick<FirewallRuleTimes, 'get' | 'set' | 'remove'>
}

type HostState = {
  active: boolean
  defaultIncoming: 'allow' | 'deny' | 'limit'
  defaultOutgoing: 'allow' | 'deny' | 'limit'
  ipv6Enabled: boolean
  pingBlocked: boolean
  lines: readonly (PortUfwLine | IpUfwLine)[]
  listeners: ReadonlySet<string>
  beforeRules: string
}

/** 面板端口保底规则若不存在则补上（带备注「Elysian 面板」）。 */
export async function ensurePanelRule(deps: FirewallHostDeps): Promise<void> {
  const stdout = await deps.runUfw(['show', 'added'])
  const exists = parseShowAdded(stdout).some(
    (line) => line.kind === 'port' && canonicalId(line.spec) === PANEL_CANONICAL,
  )
  if (!exists) {
    await deps.runUfw(['allow', `${PANEL_PORT}/tcp`, 'comment', 'Elysian 面板'])
  }
}

export function createFirewallService(deps: FirewallHostDeps): FirewallAdapter {
  const paths = deps.paths ?? DEFAULT_FIREWALL_PATHS
  /** 本会话内经面板变更过的规则（规范指纹 → ISO 时间）。 */
  const updatedAtMap = new Map<string, string>()
  /** 防扫描会话统计：历史封锁过的 IP 与其首次观察时间。 */
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

  function timeOf(canonical: string): string | null {
    return updatedAtMap.get(canonical) ?? deps.ruleTimes?.get(canonical) ?? null
  }

  function touch(canonical: string): string {
    const at = deps.nowIso()
    updatedAtMap.set(canonical, at)
    deps.ruleTimes?.set(canonical, at)
    return at
  }

  function removeTouch(canonical: string): void {
    updatedAtMap.delete(canonical)
    deps.ruleTimes?.remove(canonical)
  }

  async function readState(): Promise<HostState> {
    const [verbose, added, defaultUfw, ssOut, beforeRules] = await Promise.all([
      runUfw(['status', 'verbose']),
      runUfw(['show', 'added']),
      deps.readText(paths.defaultUfw),
      deps.runSs(),
      deps.readText(paths.beforeRules),
    ])
    const status = parseStatusVerbose(verbose)
    return {
      active: status.active,
      defaultIncoming: status.defaultIncoming,
      defaultOutgoing: status.defaultOutgoing,
      ipv6Enabled: parseIpv6Enabled(defaultUfw),
      pingBlocked: parsePingBlocked(beforeRules),
      lines: parseShowAdded(added),
      listeners: parseSsListening(ssOut),
      beforeRules,
    }
  }

  function rowContext(state: HostState): RuleRowContext {
    return {
      ipv6Enabled: state.ipv6Enabled,
      listeners: state.listeners,
      updatedAtMap: {
        get: (canonical: string) => timeOf(canonical) ?? undefined,
      } as ReadonlyMap<string, string>,
    }
  }

  function portLines(state: HostState): readonly PortUfwLine[] {
    return state.lines.filter((line): line is PortUfwLine => line.kind === 'port')
  }

  function ipLines(state: HostState): readonly IpUfwLine[] {
    return state.lines.filter((line): line is IpUfwLine => line.kind === 'ip')
  }

  function rulesOf(state: HostState): readonly FirewallRule[] {
    return portLines(state).flatMap((line) => ruleRowsFromSpec(line.spec, line.comment, rowContext(state)))
  }

  function ipRulesOf(state: HostState): readonly FirewallIpRule[] {
    return ipLines(state).map((line) => ipRuleRowFromSpec(line.spec, line.comment, rowContext(state)))
  }

  function forwardsOf(state: HostState): readonly FirewallForwardRule[] {
    return parseForwardSection(state.beforeRules).map((spec) => forwardRowFromSpec(spec, timeOf(forwardIdOf(spec))))
  }

  /** 端口规则唯一性：同协议同方向同起始端口视为重复（与真实防火墙的呈现一致）。 */
  function findDuplicate(
    state: HostState,
    input: FirewallRuleInput,
    exceptCanonical?: string,
  ): PortUfwLine | undefined {
    const direction = input.direction === 'outbound' ? 'out' : 'in'
    return portLines(state).find(
      (line) =>
        canonicalId(line.spec) !== exceptCanonical &&
        line.spec.proto === input.protocol &&
        line.spec.direction === direction &&
        displayPortOf(line.spec) === input.port,
    )
  }

  function commentArgs(comment: string | null): readonly string[] {
    return comment ? ['comment', comment] : []
  }

  function togglesOf(state: HostState): FirewallToggles {
    return {
      firewallEnabled: state.active,
      pingBlocked: state.pingBlocked,
      defaultIncoming: state.defaultIncoming,
      defaultOutgoing: state.defaultOutgoing,
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

  /**
   * 确保内核转发开启。容器里 /proc/sys 常以只读挂载（且 Docker 默认已置 1），
   * 因此先读现状：已经是 1 就直接通过；需要改而写不进去时给出可诊断的中文错误。
   * 只在有转发规则时确保开启，移除最后一条转发不强制关闭 —— 转发开关可能被别的
   * NAT 场景共用，面板不越权关掉它。
   */
  async function ensureIpForward(): Promise<void> {
    let current: string
    try {
      current = (await deps.readText(IP_FORWARD_PATH)).trim()
    } catch {
      return
    }
    if (current === '1') return
    try {
      await deps.writeText(IP_FORWARD_PATH, '1\n')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `内核转发未开启且不可写（${IP_FORWARD_PATH} 当前为 ${current}）：${detail}。请在宿主机为容器开启 net.ipv4.ip_forward=1 后重试`,
      )
    }
  }

  /**
   * 把转发段精确落到内核 nat 表：PREROUTING 的 DNAT 与 POSTROUTING 的 MASQUERADE
   * 都按 comment 标记先删净、再按段重建。不依赖 ufw reload —— ufw 以 --noflush 应用
   * before.rules 的 nat 段，reload 与重复 enable 只会让内核里的条目越积越多。
   */
  async function applyForwardsToKernel(specs: readonly ForwardSpec[]): Promise<void> {
    const chains: Array<{
      name: 'PREROUTING' | 'POSTROUTING'
      argsOf: (spec: ForwardSpec) => readonly string[]
    }> = [
      { name: 'PREROUTING', argsOf: natRuleArgsOf },
      { name: 'POSTROUTING', argsOf: postRoutingArgsOf },
    ]
    for (const chain of chains) {
      const listing = await deps.runIptables(['-t', 'nat', '-L', chain.name, '-n', '--line-numbers'])
      const numbers = parseOurNatRuleNumbers(listing)
      // 行号从大到小删：删前面的会让后面的行号前移。
      for (const num of [...numbers].reverse()) {
        await deps.runIptables(['-t', 'nat', '-D', chain.name, String(num)])
      }
      for (const spec of specs) {
        await deps.runIptables(['-t', 'nat', '-A', chain.name, ...chain.argsOf(spec)])
      }
    }
  }

  /**
   * 重写端口转发：nat 段（文件最前）与 forward 放行段（filter 块内）一起落盘，
   * nat 精确落到内核，再 reload 让放行段生效（reload 会顺带保证 nat 不累加）。
   * specs 为空则两段移除、内核里的本面板规则删净。
   */
  async function writeForwards(specs: readonly ForwardSpec[]): Promise<void> {
    const text = await deps.readText(paths.beforeRules)
    const withNat = setForwardSection(text, specs)
    const next = setForwardFilterSection(withNat, specs)
    await deps.writeText(paths.beforeRules, next)
    if (specs.length > 0) {
      await ensureIpForward()
    }
    await applyForwardsToKernel(specs)
    const state = await readState()
    if (state.active) {
      await applyRulesFile()
    }
  }

  /**
   * 让 before.rules 的改动生效。ufw 0.36 的 `reload`（以及已激活时的重复 `enable`）
   * 都不会重放 before.rules，只有完整的 disable → enable 才会——这是实测结论。
   * 因此这里走一轮完整重启，并在重启后：
   * - 按转发段重建内核 nat（enable 以 --noflush 追加 nat 段，会留下重复条目）；
   * - 确认防火墙确实回到激活状态（规则文件有问题时 ufw 会停在停用态）。
   */
  async function applyRulesFile(): Promise<void> {
    const specs = parseForwardSection(await deps.readText(paths.beforeRules))
    await ensurePanelRule(deps)
    await runUfw(['--force', 'disable'])
    await runUfw(['--force', 'enable'])
    if (specs.length > 0) {
      await ensureIpForward()
    }
    await applyForwardsToKernel(specs)

    const status = await runUfw(['status', 'verbose'])
    if (!parseStatusVerbose(status).active) {
      throw new Error('规则重载后防火墙未处于激活状态：before.rules 可能有问题，请检查后重试')
    }
  }

  /** 汇总防扫描实时状态：名单来自内核 recent 文件，拦截计数来自 v4/v6 DROP 规则计数器。 */
  async function readScanProtection(): Promise<FirewallScanProtection> {
    const beforeRules = await deps.readText(paths.beforeRules)
    const { enabled, config } = parseScanSection(beforeRules)

    let ips: readonly string[] = []
    let dropCounter = 0
    if (enabled) {
      try {
        // 规则段已写入但 ufw 尚未 reload（或未激活）时，内核名单文件还不存在：视为空名单。
        const [v4Exists, v6Exists] = await Promise.all([
          deps.exists(SCAN_BANNED_RECENT_PATH),
          deps.exists(SCAN_BANNED6_RECENT_PATH),
        ])
        const v4 = v4Exists ? parseRecentList(await deps.readText(SCAN_BANNED_RECENT_PATH)) : []
        const v6 = v6Exists ? parseRecentList(await deps.readText(SCAN_BANNED6_RECENT_PATH)) : []
        ips = [...v4, ...v6]
        const [v4Count, v6Count] = await Promise.all([
          deps.runIptables(['-L', SCAN_TABLES_V4_CHAIN, '-nvx']),
          deps.runIp6tables(['-L', SCAN_TABLES_V6_CHAIN, '-nvx']),
        ])
        dropCounter = parseDropCounter(v4Count) + parseDropCounter(v6Count)
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
      config,
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

  /** 双栈规则文件同步写扫描段（v4 与 v6 的链与名单名不同）。 */
  async function writeScanSection(enabled: boolean, config: FirewallScanConfig): Promise<void> {
    const [beforeV4, beforeV6] = await Promise.all([
      deps.readText(paths.beforeRules),
      deps.exists(paths.beforeRulesV6).then((exists) => (exists ? deps.readText(paths.beforeRulesV6) : null)),
    ])
    await deps.writeText(paths.beforeRules, setScanSection(beforeV4, enabled, config, 'v4'))
    if (beforeV6 !== null) {
      await deps.writeText(paths.beforeRulesV6, setScanSection(beforeV6, enabled, config, 'v6'))
    }
    const state = await readState()
    if (state.active) {
      await applyRulesFile()
    }
  }

  return {
    async list() {
      const state = await readState()
      return rulesOf(state)
    },

    async listIpRules() {
      const state = await readState()
      return ipRulesOf(state)
    },

    async listForwards() {
      const state = await readState()
      return forwardsOf(state)
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
          await applyRulesFile()
        }
      }

      return togglesOf(await readState())
    },

    async create(input) {
      const spec = specFromInput(input)
      const state = await readState()
      const duplicate = findDuplicate(state, input)
      if (duplicate) {
        throw new Error(`端口规则已存在：${input.protocol} ${input.port}（${input.family}）`)
      }
      await runUfw([...specToArgs(spec), ...commentArgs(input.note)])
      touch(canonicalId(spec))
      return firstRow(ruleRowsFromSpec(spec, input.note, rowContext(await readState())))
    },

    async update(ruleId, input) {
      const parsed = parseRuleId(ruleId)
      if (!parsed) throw new Error(`无效的规则标识：${ruleId}`)
      const state = await readState()
      const oldCanonical = canonicalId(parsed.spec)
      const existing = portLines(state).find((line) => canonicalId(line.spec) === oldCanonical)
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
      removeTouch(oldCanonical)
      touch(nextCanonical)

      return firstRow(ruleRowsFromSpec(spec, input.note, rowContext(await readState())))
    },

    async remove(ruleId) {
      const parsed = parseRuleId(ruleId)
      if (!parsed) throw new Error(`无效的规则标识：${ruleId}`)
      if (canonicalId(parsed.spec) === PANEL_CANONICAL) {
        throw new Error('面板端口规则不允许删除：它是保证工作台可访问的保底规则')
      }
      const state = await readState()
      const exists = portLines(state).some((line) => canonicalId(line.spec) === canonicalId(parsed.spec))
      if (!exists) throw new Error(`未找到端口规则 ${ruleId}（可能已在系统侧变更，请先同步）`)
      await runUfw(['delete', ...specToArgs(parsed.spec)])
      removeTouch(canonicalId(parsed.spec))
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
        touch(canonicalId(spec))
        added.push(firstRow(ruleRowsFromSpec(spec, input.note, rowContext(await readState()))))
      }
      return { added, skipped }
    },

    async createIpRule(input) {
      const spec = ipSpecFromInput(input)
      const state = await readState()
      const duplicate = ipLines(state).find((line) => ipCanonicalId(line.spec) === ipCanonicalId(spec))
      if (duplicate) {
        throw new Error(`IP 规则已存在：${input.source}`)
      }
      await runUfw([...ipSpecToArgs(spec), ...commentArgs(input.note)])
      touch(ipCanonicalId(spec))
      return ipRuleRowFromSpec(spec, input.note, rowContext(await readState()))
    },

    async updateIpRule(ruleId, input) {
      const parsed = parseIpRuleId(ruleId)
      if (!parsed) throw new Error(`无效的 IP 规则标识：${ruleId}`)
      const state = await readState()
      const oldCanonical = ipCanonicalId(parsed.spec)
      const exists = ipLines(state).some((line) => ipCanonicalId(line.spec) === oldCanonical)
      if (!exists) throw new Error(`未找到 IP 规则 ${ruleId}（可能已在系统侧变更，请先同步）`)

      const spec = ipSpecFromInput(input)
      if (ipLines(state).some((line) => ipCanonicalId(line.spec) === ipCanonicalId(spec) && ipCanonicalId(line.spec) !== oldCanonical)) {
        throw new Error(`IP 规则已存在：${input.source}`)
      }
      // ufw 无原地修改：先建新、再删旧；新旧行相同（只改备注）时退化为先删后建。
      if (ipCanonicalId(spec) === oldCanonical) {
        await runUfw(['delete', ...ipSpecToArgs(parsed.spec)])
        await runUfw([...ipSpecToArgs(spec), ...commentArgs(input.note)])
      } else {
        await runUfw([...ipSpecToArgs(spec), ...commentArgs(input.note)])
        await runUfw(['delete', ...ipSpecToArgs(parsed.spec)])
      }
      removeTouch(oldCanonical)
      touch(ipCanonicalId(spec))
      return ipRuleRowFromSpec(spec, input.note, rowContext(await readState()))
    },

    async removeIpRule(ruleId) {
      const parsed = parseIpRuleId(ruleId)
      if (!parsed) throw new Error(`无效的 IP 规则标识：${ruleId}`)
      const state = await readState()
      const exists = ipLines(state).some((line) => ipCanonicalId(line.spec) === ipCanonicalId(parsed.spec))
      if (!exists) throw new Error(`未找到 IP 规则 ${ruleId}（可能已在系统侧变更，请先同步）`)
      await runUfw(['delete', ...ipSpecToArgs(parsed.spec)])
      removeTouch(ipCanonicalId(parsed.spec))
    },

    async createForward(input) {
      const spec = specFromForwardInput(input)
      const state = await readState()
      const existing = parseForwardSection(state.beforeRules)
      const conflict = existing.find(
        (candidate) => candidate.protocol === spec.protocol && candidate.port.split(':')[0] === spec.port.split(':')[0],
      )
      if (conflict) {
        throw new Error(`端口转发已存在：${spec.protocol} ${spec.port.split(':')[0]}`)
      }
      await writeForwards([...existing, spec])
      touch(forwardIdOf(spec))
      return forwardRowFromSpec(spec, timeOf(forwardIdOf(spec)))
    },

    async updateForward(ruleId, input) {
      const oldSpec = parseForwardId(ruleId)
      if (!oldSpec) throw new Error(`无效的转发标识：${ruleId}`)
      const state = await readState()
      const existing = parseForwardSection(state.beforeRules)
      const oldId = forwardIdOf(oldSpec)
      if (!existing.some((candidate) => forwardIdOf(candidate) === oldId)) {
        throw new Error(`未找到端口转发 ${ruleId}（可能已在系统侧变更，请先同步）`)
      }
      const spec = specFromForwardInput(input)
      const conflict = existing.find(
        (candidate) =>
          forwardIdOf(candidate) !== oldId &&
          candidate.protocol === spec.protocol &&
          candidate.port.split(':')[0] === spec.port.split(':')[0],
      )
      if (conflict) {
        throw new Error(`端口转发已存在：${spec.protocol} ${spec.port.split(':')[0]}`)
      }
      // 段整体重写：新旧替换一次完成，无中间态。
      await writeForwards([...existing.filter((candidate) => forwardIdOf(candidate) !== oldId), spec])
      removeTouch(oldId)
      touch(forwardIdOf(spec))
      return forwardRowFromSpec(spec, timeOf(forwardIdOf(spec)))
    },

    async removeForward(ruleId) {
      const oldSpec = parseForwardId(ruleId)
      if (!oldSpec) throw new Error(`无效的转发标识：${ruleId}`)
      const state = await readState()
      const existing = parseForwardSection(state.beforeRules)
      const oldId = forwardIdOf(oldSpec)
      if (!existing.some((candidate) => forwardIdOf(candidate) === oldId)) {
        throw new Error(`未找到端口转发 ${ruleId}（可能已在系统侧变更，请先同步）`)
      }
      await writeForwards(existing.filter((candidate) => forwardIdOf(candidate) !== oldId))
      removeTouch(oldId)
    },

    async scanProtection(): Promise<FirewallScanProtection> {
      return readScanProtection()
    },

    async setScanProtection(enabled) {
      const { config } = parseScanSection(await deps.readText(paths.beforeRules))
      await writeScanSection(enabled, config)
      // 开启时刻重置快照，「当前连接失败次数」从零起算。
      if (enabled) scanDropSnapshot = 0
      return readScanProtection()
    },

    async setScanConfig(config) {
      const { enabled } = parseScanSection(await deps.readText(paths.beforeRules))
      if (!enabled) {
        throw new Error('防扫描未启用：先开启开关再调整配置')
      }
      await writeScanSection(true, config)
      return readScanProtection()
    },

    async unblockIp(ip) {
      const { enabled } = parseScanSection(await deps.readText(paths.beforeRules))
      if (!enabled) {
        throw new Error('防扫描未启用：没有可解封的 IP')
      }
      const target = validateUnblockIp(ip)
      // 内核 recent 名单按地址族分文件：v6 地址写 v6 名单，其余写 v4 名单。
      const path = target.includes(':') ? SCAN_BANNED6_RECENT_PATH : SCAN_BANNED_RECENT_PATH
      const blocked = (await deps.exists(path)) ? parseRecentList(await deps.readText(path)) : []
      if (!blocked.includes(target)) {
        throw new Error(`IP ${target} 不在封锁名单中`)
      }
      await deps.writeText(path, `-${target}\n`)
      return readScanProtection()
    },

    async syncFromSystem() {
      const state = await readState()
      return {
        total: rulesOf(state).length + ipRulesOf(state).length + forwardsOf(state).length,
      }
    },
  }
}

const SCAN_TABLES_V4_CHAIN = 'ufw-before-input'
const SCAN_TABLES_V6_CHAIN = 'ufw6-before-input'

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
