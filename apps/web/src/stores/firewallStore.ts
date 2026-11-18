import { securityActionFailure, securitySessionChanged, type SecurityActionResult } from './securityActionResult'
import { captureAuthGeneration } from '../utils/authGeneration'
import type {
  FirewallForwardInput,
  FirewallForwardRule,
  FirewallIpRule,
  FirewallIpRuleInput,
  FirewallRule,
  FirewallRuleInput,
  FirewallScanConfig,
  FirewallScanProtection,
  FirewallToggles,
} from '@elysian/contracts'
import { create } from 'zustand'
import { hasUncertainOutcome } from '../adapters/http/requestDeadline'
import type { ElysianGateway } from '../contracts/adapters'
import { isDockerRuntime } from '../utils/isDockerRuntime'
import { useMessageStore } from './messageStore'

/** 每页行数与参照产品的默认值一致；演示数据约 27 条，正好跨两页。 */
export const FIREWALL_PAGE_SIZE = 20

/** Docker 真实模式下动作已真实执行 ufw，完成提示不再带演示标注；宿主机本地开发（内存演示）保留标注。 */
const REAL_ACTION_LABEL = isDockerRuntime() ? '' : '（mock，待接入真实执行）'

/** 防火墙面板的三类规则视图。 */
export type FirewallView = 'port' | 'ip' | 'forward'

type FirewallStatus = 'idle' | 'loading' | 'ready' | 'error'

type FirewallState = {
  status: FirewallStatus
  errorMessage: string | undefined
  operationError: string | undefined
  rules: readonly FirewallRule[]
  ipRules: readonly FirewallIpRule[]
  forwards: readonly FirewallForwardRule[]
  view: FirewallView
  toggles: FirewallToggles
  /** 搜索按当前视图的端口/IP/目标与备注匹配；变化时回到第一页。 */
  search: string
  page: number
  /** 端口规则弹窗状态：editing 为 null 表示新建，非 null 表示在改这条规则。 */
  dialogRule: FirewallRule | 'new' | undefined
  /** IP 规则弹窗状态。 */
  dialogIpRule: FirewallIpRule | 'new' | undefined
  /** 端口转发弹窗状态。 */
  dialogForward: FirewallForwardRule | 'new' | undefined
  /** 待确认删除的规则（三类共用一个确认弹窗，按 kind 区分）。 */
  removeTarget: { kind: 'port' | 'ip' | 'forward'; id: string; label: string } | undefined
  /** 端口操作区与表单共用的防扫描事实。 */
  scanSaving: boolean
  scanStatus: 'idle' | 'loading' | 'ready' | 'error'
  scanError?: string
  scanProtection: FirewallScanProtection
  /** 同步规则的忙碌态。 */
  syncing: boolean
  saving: boolean
  /** 开关切换的忙碌态：进行中忽略后续切换，防止两笔 in-flight 交错把界面拉离系统真实状态。 */
  toggling: boolean
  unblockingIps: readonly string[]
  removingRuleIds: readonly string[]
  load: (gateway: ElysianGateway) => Promise<void>
  /** 变更成功后的静默重拉：不动 status，面板不闪加载态。 */
  refreshLists: (gateway: ElysianGateway) => Promise<void>
  setView: (view: FirewallView) => void
  setSearch: (search: string) => void
  setPage: (page: number) => void
  toggle: (gateway: ElysianGateway, next: FirewallToggles) => Promise<void>
  openCreate: () => void
  openCreateIp: () => void
  openCreateForward: () => void
  openEdit: (rule: FirewallRule) => void
  openEditIp: (rule: FirewallIpRule) => void
  openEditForward: (rule: FirewallForwardRule) => void
  closeDialog: () => void
  openRemove: (target: { kind: 'port' | 'ip' | 'forward'; id: string; label: string }) => void
  closeRemove: () => void
  saveRule: (gateway: ElysianGateway, input: FirewallRuleInput, scanEnabled?: boolean, scanConfig?: Omit<FirewallScanConfig, 'ports'>) => Promise<boolean>
  saveIpRule: (gateway: ElysianGateway, input: FirewallIpRuleInput) => Promise<boolean>
  saveForward: (gateway: ElysianGateway, input: FirewallForwardInput) => Promise<boolean>
  removeRule: (gateway: ElysianGateway, kind: 'port' | 'ip' | 'forward', ruleId: string) => Promise<SecurityActionResult>
  refreshScan: (gateway: ElysianGateway) => Promise<void>
  unblockIp: (gateway: ElysianGateway, ip: string) => Promise<SecurityActionResult>
  setRuleScan: (gateway: ElysianGateway, ruleId: string, enabled: boolean, config?: Omit<FirewallScanConfig, 'ports'>) => Promise<boolean>
  syncFromSystem: (gateway: ElysianGateway) => Promise<void>
}

function notify(message: string, tone: 'success' | 'danger' = 'success'): void {
  useMessageStore.getState().notify({ message, tone })
}

async function readFirewall(gateway: ElysianGateway) {
  const [toggles, rules, ipRules, forwards] = await Promise.all([
    gateway.firewall.toggles(), gateway.firewall.list(), gateway.firewall.listIpRules(), gateway.firewall.listForwards(),
  ])
  return { toggles, rules, ipRules, forwards }
}

let pendingLoad: { gateway: ElysianGateway; auth: number; snapshot: Pick<FirewallState, 'rules' | 'ipRules' | 'forwards' | 'toggles'>; promise: Promise<void> } | undefined

function sameReadSnapshot(snapshot: Pick<FirewallState, 'rules' | 'ipRules' | 'forwards' | 'toggles'>, state: FirewallState): boolean {
  return snapshot.rules === state.rules && snapshot.ipRules === state.ipRules && snapshot.forwards === state.forwards && snapshot.toggles === state.toggles
}

export const useFirewallStore = create<FirewallState>((set, get) => {
  let actionAuth = captureAuthGeneration()
  let scanRevision = 0
  let pendingScan: { auth: number; gateway: ElysianGateway; promise: Promise<void> } | undefined
  const syncActionGeneration = () => {
    const auth = captureAuthGeneration()
    if (auth !== actionAuth) {
      actionAuth = auth
      set({ removingRuleIds: [], unblockingIps: [], scanSaving: false, saving: false })
    }
    return auth
  }
  return ({
  status: 'idle',
  errorMessage: undefined,
  operationError: undefined,
  rules: [],
  ipRules: [],
  forwards: [],
  view: 'port',
  toggles: { firewallEnabled: true, pingBlocked: true, defaultIncoming: 'deny', defaultOutgoing: 'allow' },
  search: '',
  page: 1,
  dialogRule: undefined,
  dialogIpRule: undefined,
  dialogForward: undefined,
  removeTarget: undefined,
  scanSaving: false,
  scanStatus: 'idle',
  scanError: undefined,
  scanProtection: {
    enabled: false,
    config: { ports: [], windowSeconds: 60, hitCount: 8, banSeconds: 3600 },
    stats: { totalBlockedIps: 0, totalFailedConnections: 0, currentBlockedIps: 0, currentFailedConnections: 0 },
    blocked: [],
  },
  syncing: false,
  saving: false,
  toggling: false,
  unblockingIps: [],
  removingRuleIds: [],

  load(gateway) {
    const auth = syncActionGeneration()
    if (pendingLoad?.gateway === gateway && pendingLoad.auth === auth && sameReadSnapshot(pendingLoad.snapshot, get())) return pendingLoad.promise
    const hadData = get().status === 'ready'
    const operation = { gateway, auth, snapshot: { rules: get().rules, ipRules: get().ipRules, forwards: get().forwards, toggles: get().toggles }, promise: Promise.resolve() }
    pendingLoad = operation
    const current = () => pendingLoad === operation && auth === captureAuthGeneration()
    set({ status: hadData ? 'ready' : 'loading', errorMessage: undefined })
    operation.promise = (async () => {
      try {
        const [data] = await Promise.all([readFirewall(gateway), get().refreshScan(gateway)])
        if (current() && sameReadSnapshot(operation.snapshot, get())) set({ status: 'ready', ...data, operationError: undefined, errorMessage: undefined })
      } catch (error) {
        if (current()) set({ status: hadData ? 'ready' : 'error', errorMessage: error instanceof Error ? error.message : '防火墙数据加载失败' })
      } finally { if (pendingLoad === operation) pendingLoad = undefined }
    })()
    return operation.promise
  },

  setView(view) {
    // 切换视图清空搜索与页码：三类列表的搜索词不通用。
    set({ view, search: '', page: 1 })
  },

  // ufw 一条端口规则在系统里是 v4/v6 两行，而 create/update 的响应只带回首行；
  // 局部追加/替换会让列表落后于系统（看不见的行又让判重报错显得无中生有）。
  // 变更成功后以系统为唯一事实重拉；失败只报通知，列表保持原样。
  async refreshLists(gateway) {
    const auth = captureAuthGeneration()
    try {
      const [data] = await Promise.all([readFirewall(gateway), get().refreshScan(gateway)])
      if (auth !== captureAuthGeneration()) return
      set({ ...data, operationError: undefined })
    } catch (error) {
      if (auth !== captureAuthGeneration()) return
      const message = error instanceof Error ? `列表同步失败：${error.message}` : '列表同步失败'
      set({ operationError: message })
      notify(message, 'danger')
    }
  },

  setSearch(search) {
    set({ search, page: 1 })
  },

  setPage(page) {
    set({ page })
  },

  // 乐观更新：开关先翻再等 adapter 确认，失败回滚并报危险通知；忙碌中忽略后续切换。
  async toggle(gateway, next) {
    const previous = get().toggles
    if (get().toggling) return
    set({ toggling: true, toggles: next, operationError: undefined })
    try {
      const confirmed = await gateway.firewall.setToggles(next)
      set({ toggles: confirmed, toggling: false })
      notify(
        next.firewallEnabled !== previous.firewallEnabled
          ? `防火墙已${next.firewallEnabled ? '开启' : '关闭'}${REAL_ACTION_LABEL}`
          : `禁 ping 已${next.pingBlocked ? '开启' : '关闭'}${REAL_ACTION_LABEL}`,
      )
    } catch (error) {
      const message = error instanceof Error ? `切换失败：${error.message}` : '切换失败'
      set({ toggles: previous, operationError: message })
      notify(message, 'danger')
      if (hasUncertainOutcome(error)) {
        try { set(await readFirewall(gateway)) } catch { /* 保留未确认提示，由用户重试读取。 */ }
      }
    } finally {
      set({ toggling: false })
    }
  },

  openCreate() {
    set({ dialogRule: 'new', operationError: undefined })
  },

  openCreateIp() {
    set({ dialogIpRule: 'new', operationError: undefined })
  },

  openCreateForward() {
    set({ dialogForward: 'new', operationError: undefined })
  },

  openEdit(rule) {
    set({ dialogRule: rule, operationError: undefined })
  },

  openEditIp(rule) {
    set({ dialogIpRule: rule, operationError: undefined })
  },

  openEditForward(rule) {
    set({ dialogForward: rule, operationError: undefined })
  },

  closeDialog() {
    set({ dialogRule: undefined, dialogIpRule: undefined, dialogForward: undefined })
  },

  openRemove(target) {
    set({ removeTarget: target })
  },

  closeRemove() {
    set({ removeTarget: undefined })
  },

  async saveRule(gateway, input, scanEnabled, scanConfig) {
    const editing = get().dialogRule
    const auth = syncActionGeneration()
    if (editing === undefined || get().saving || get().scanSaving) return false
    set({ saving: true, operationError: undefined })
    let saved: FirewallRule | undefined
    try {
      // 扫描设置失败后已保存的规则成为编辑目标；原样重试只重试扫描，不重复创建/改写规则。
      const unchanged = editing !== 'new' && editing.protocol === input.protocol && editing.port === input.port
        && editing.portTo === (input.portTo ?? null) && (isDockerRuntime() || editing.family === input.family) && editing.policy === input.policy
        && editing.direction === (input.direction ?? 'inbound') && editing.source === input.source && editing.note === input.note
      saved = unchanged ? editing : editing === 'new'
        ? await gateway.firewall.create(input) : await gateway.firewall.update(editing.id, input)
      if (auth !== captureAuthGeneration()) return false
      if (scanEnabled !== undefined) {
        set({ dialogRule: saved })
        const applied = await get().setRuleScan(gateway, saved.id, scanEnabled, scanConfig)
        if (auth !== captureAuthGeneration()) return false
        if (!applied) {
          const detail = get().scanError || '请刷新状态后重试'
          await get().refreshLists(gateway)
          if (auth !== captureAuthGeneration()) return false
          set({ operationError: `规则已保存，防扫描设置未完成：${detail}。可在此重试。` })
          return false
        }
      }
      set({ dialogRule: undefined })
      notify(`端口规则 ${saved.protocol} ${saved.port}${saved.portTo ? `:${saved.portTo}` : ''} 已${editing === 'new' ? '添加' : '修改'}${REAL_ACTION_LABEL}`)
      await get().refreshLists(gateway)
      return true
    } catch (error) {
      if (auth !== captureAuthGeneration()) return false
      const message = error instanceof Error ? `保存失败：${error.message}` : '保存失败'
      if (hasUncertainOutcome(error)) await get().refreshLists(gateway)
      if (auth !== captureAuthGeneration()) return false
      set({ operationError: message })
      notify(message, 'danger')
      return false
    } finally {
      if (auth === captureAuthGeneration()) set({ saving: false })
    }
  },

  async saveIpRule(gateway, input) {
    const editing = get().dialogIpRule
    if (editing === undefined || get().saving) return false
    set({ saving: true, operationError: undefined })
    try {
      if (editing === 'new') {
        const created = await gateway.firewall.createIpRule(input)
        set({ dialogIpRule: undefined, saving: false })
        notify(`IP 规则 ${created.source} 已添加${REAL_ACTION_LABEL}`)
      } else {
        const updated = await gateway.firewall.updateIpRule(editing.id, input)
        set({ dialogIpRule: undefined, saving: false })
        notify(`IP 规则 ${updated.source} 已修改${REAL_ACTION_LABEL}`)
      }
      await get().refreshLists(gateway)
      return true
    } catch (error) {
      const message = error instanceof Error ? `保存失败：${error.message}` : '保存失败'
      set({ saving: false, operationError: message })
      notify(message, 'danger')
      return false
    }
  },

  async saveForward(gateway, input) {
    const editing = get().dialogForward
    if (editing === undefined || get().saving) return false
    set({ saving: true, operationError: undefined })
    try {
      if (editing === 'new') {
        const created = await gateway.firewall.createForward(input)
        set({ dialogForward: undefined, saving: false })
        notify(`端口转发 ${created.protocol} ${created.port} → ${created.targetHost}:${created.targetPort} 已添加${REAL_ACTION_LABEL}`)
      } else {
        const updated = await gateway.firewall.updateForward(editing.id, input)
        set({ dialogForward: undefined, saving: false })
        notify(`端口转发 ${updated.protocol} ${updated.port} → ${updated.targetHost}:${updated.targetPort} 已修改${REAL_ACTION_LABEL}`)
      }
      await get().refreshLists(gateway)
      return true
    } catch (error) {
      const message = error instanceof Error ? `保存失败：${error.message}` : '保存失败'
      set({ saving: false, operationError: message })
      notify(message, 'danger')
      return false
    }
  },

  async removeRule(gateway, kind, ruleId) {
    const auth = syncActionGeneration()
    if (get().removingRuleIds.includes(ruleId)) return { status: 'failed', error: '该规则正在删除，请等待完成' }
    const state = get()
    // 通知里带上规则摘要，删除哪条一目了然。
    const label =
      kind === 'port'
        ? (() => {
            const rule = state.rules.find((item) => item.id === ruleId)
            return rule ? `端口规则 ${rule.protocol} ${rule.port}${rule.portTo ? `:${rule.portTo}` : ''}` : '端口规则'
          })()
        : kind === 'ip'
          ? (() => {
              const rule = state.ipRules.find((item) => item.id === ruleId)
              return rule ? `IP 规则 ${rule.source}` : 'IP 规则'
            })()
          : (() => {
              const rule = state.forwards.find((item) => item.id === ruleId)
              return rule ? `端口转发 ${rule.protocol} ${rule.port} → ${rule.targetHost}:${rule.targetPort}` : '端口转发'
            })()
    set((current) => ({ removingRuleIds: [...current.removingRuleIds, ruleId] }))
    try {
      if (kind === 'port') {
        await gateway.firewall.remove(ruleId)
      } else if (kind === 'ip') {
        await gateway.firewall.removeIpRule(ruleId)
      } else {
        await gateway.firewall.removeForward(ruleId)
      }
      if (auth !== captureAuthGeneration()) return securitySessionChanged()
      set((current) => ({ removingRuleIds: current.removingRuleIds.filter((id) => id !== ruleId) }))
      notify(`${label} 已删除${REAL_ACTION_LABEL}`)
      // 删除同样按规范成对移除 v4/v6 双生行，重拉才能反映完整后果。
      await get().refreshLists(gateway)
      return { status: 'succeeded' }
    } catch (error) {
      if (auth !== captureAuthGeneration()) return securitySessionChanged()
      set((current) => ({
        removingRuleIds: current.removingRuleIds.filter((id) => id !== ruleId),
      }))
      notify(error instanceof Error ? `删除失败：${error.message}` : '删除失败', 'danger')
      if (hasUncertainOutcome(error)) await get().refreshLists(gateway)
      return securityActionFailure(error, '删除失败')
    }
  },

  async refreshScan(gateway) {
    const auth = syncActionGeneration()
    if (get().scanSaving) return
    if (pendingScan?.auth === auth && pendingScan.gateway === gateway) return pendingScan.promise
    const revision = ++scanRevision
    const operation = { auth, gateway, promise: Promise.resolve() }
    pendingScan = operation
    set({ scanStatus: get().scanStatus === 'ready' ? 'ready' : 'loading' })
    operation.promise = (async () => {
      try {
        const scanProtection = await gateway.firewall.scanProtection()
        if (auth === captureAuthGeneration() && revision === scanRevision) set({ scanProtection, scanStatus: 'ready', scanError: undefined })
      } catch (error) {
        if (auth !== captureAuthGeneration() || revision !== scanRevision) return
        set({ scanStatus: 'error', scanError: error instanceof Error ? error.message : '读取防扫描状态失败' })
      } finally { if (pendingScan === operation) pendingScan = undefined }
    })()
    return operation.promise
  },

  async setRuleScan(gateway, ruleId, enabled, config) {
    const auth = syncActionGeneration()
    if (get().scanSaving) return false
    ++scanRevision
    pendingScan = undefined
    set({ scanSaving: true, scanError: undefined })
    let savingConfig = false
    try {
      let scanProtection = await gateway.firewall.setRuleScanProtection(ruleId, enabled)
      if (auth !== captureAuthGeneration()) return false
      set({ scanProtection, scanStatus: 'ready', scanError: undefined })
      if (enabled && config && (config.windowSeconds !== scanProtection.config.windowSeconds
        || config.hitCount !== scanProtection.config.hitCount || config.banSeconds !== scanProtection.config.banSeconds)) {
        savingConfig = true
        // 使用端口启停回执里的最新列表，保留其他已保护端口；阈值沿用现有共享配置接口。
        scanProtection = await gateway.firewall.setScanConfig({ ...config, ports: scanProtection.config.ports })
        if (auth !== captureAuthGeneration()) return false
        set({ scanProtection, scanStatus: 'ready', scanError: undefined })
      }
      return true
    } catch (error) {
      if (auth !== captureAuthGeneration()) return false
      const detail = error instanceof Error ? error.message : '防扫描设置失败'
      const message = savingConfig ? `防扫描配置保存失败：${detail}` : detail
      // 所有失败均回读事实，尤其写超时不能把旧快照当成已回滚，也不自动重投。
      set({ scanSaving: false, scanStatus: 'loading' })
      await get().refreshScan(gateway)
      if (auth !== captureAuthGeneration()) return false
      set({ scanError: message })
      notify(`防扫描设置失败：${message}`, 'danger')
      return false
    } finally {
      if (auth === captureAuthGeneration()) set({ scanSaving: false })
    }
  },

  async unblockIp(gateway, ip) {
    const auth = syncActionGeneration()
    if (get().unblockingIps.includes(ip)) return { status: 'failed', error: '该 IP 正在解封，请等待完成' }
    set(state => ({ unblockingIps: [...state.unblockingIps, ip] }))
    try {
      const next = await gateway.firewall.unblockIp(ip)
      if (auth !== captureAuthGeneration()) return securitySessionChanged()
      set(state => ({ scanProtection: next, unblockingIps: state.unblockingIps.filter(item => item !== ip) }))
      notify(`已解封 IP ${ip}${REAL_ACTION_LABEL}`)
      return { status: 'succeeded' }
    } catch (error) {
      if (auth !== captureAuthGeneration()) return securitySessionChanged()
      set(state => ({ unblockingIps: state.unblockingIps.filter(item => item !== ip) }))
      notify(error instanceof Error ? `解封失败：${error.message}` : '解封失败', 'danger')
      if (hasUncertainOutcome(error)) await get().refreshScan(gateway)
      return securityActionFailure(error, '解封失败')
    }
  },

  async syncFromSystem(gateway) {
    if (get().syncing) return
    const auth = syncActionGeneration()
    set({ syncing: true })
    try {
      await gateway.firewall.syncFromSystem()
      // 同步后重拉三类列表，让系统侧（含命令行手敲）的规则进面板。
      const [data] = await Promise.all([readFirewall(gateway), get().refreshScan(gateway)])
      if (auth !== captureAuthGeneration()) return
      set({ ...data, status: 'ready', errorMessage: undefined, operationError: undefined })
      notify(`已从操作系统同步防火墙规则，当前共 ${get().rules.length + get().ipRules.length + get().forwards.length} 条${REAL_ACTION_LABEL}`)
    } catch (error) {
      if (auth !== captureAuthGeneration()) return
      const message = error instanceof Error ? `同步失败：${error.message}` : '同步失败'
      set({ operationError: message })
      notify(message, 'danger')
    } finally {
      if (auth === captureAuthGeneration()) set({ syncing: false })
    }
  },
})
})
