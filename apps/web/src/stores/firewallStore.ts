import type {
  FirewallForwardInput,
  FirewallForwardRule,
  FirewallImportResult,
  FirewallIpRule,
  FirewallIpRuleInput,
  FirewallRule,
  FirewallRuleInput,
  FirewallScanConfig,
  FirewallScanProtection,
  FirewallToggles,
} from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway } from '../contracts/adapters'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import { useNotificationStore } from './notificationStore'

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
  /** 防扫描弹窗：数据在首次打开时懒加载，打开期间轮询刷新。 */
  scanDialogOpen: boolean
  scanStatus: 'idle' | 'loading' | 'ready' | 'error'
  scanProtection: FirewallScanProtection
  /** 导出方向选择弹窗。 */
  exportDialogOpen: boolean
  /** 同步规则的忙碌态。 */
  syncing: boolean
  saving: boolean
  /** 开关切换的忙碌态：进行中忽略后续切换，防止两笔 in-flight 交错把界面拉离系统真实状态。 */
  toggling: boolean
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
  saveRule: (gateway: ElysianGateway, input: FirewallRuleInput) => Promise<boolean>
  saveIpRule: (gateway: ElysianGateway, input: FirewallIpRuleInput) => Promise<boolean>
  saveForward: (gateway: ElysianGateway, input: FirewallForwardInput) => Promise<boolean>
  removeRule: (gateway: ElysianGateway, kind: 'port' | 'ip' | 'forward', ruleId: string) => Promise<void>
  importRules: (gateway: ElysianGateway, inputs: readonly FirewallRuleInput[]) => Promise<FirewallImportResult>
  openExport: () => void
  closeExport: () => void
  openScan: (gateway: ElysianGateway) => void
  closeScan: () => void
  refreshScan: (gateway: ElysianGateway) => Promise<void>
  toggleScanProtection: (gateway: ElysianGateway, enabled: boolean) => Promise<void>
  setScanConfig: (gateway: ElysianGateway, config: FirewallScanConfig) => Promise<void>
  unblockIp: (gateway: ElysianGateway, ip: string) => Promise<void>
  syncFromSystem: (gateway: ElysianGateway) => Promise<void>
}

function notify(message: string, tone: 'success' | 'danger' = 'success'): void {
  useNotificationStore.getState().notify({ message, tone })
}

export const useFirewallStore = create<FirewallState>((set, get) => ({
  status: 'idle',
  errorMessage: undefined,
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
  scanDialogOpen: false,
  scanStatus: 'idle',
  scanProtection: {
    enabled: false,
    config: { ports: [], windowSeconds: 60, hitCount: 8, banSeconds: 3600 },
    stats: { totalBlockedIps: 0, totalFailedConnections: 0, currentBlockedIps: 0, currentFailedConnections: 0 },
    blocked: [],
  },
  exportDialogOpen: false,
  syncing: false,
  saving: false,
  toggling: false,
  removingRuleIds: [],

  async load(gateway) {
    if (get().status === 'loading') return
    set({ status: 'loading' })
    try {
      const [toggles, rules, ipRules, forwards] = await Promise.all([
        gateway.firewall.toggles(),
        gateway.firewall.list(),
        gateway.firewall.listIpRules(),
        gateway.firewall.listForwards(),
      ])
      set({ status: 'ready', toggles, rules, ipRules, forwards, errorMessage: undefined })
    } catch (error) {
      set({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    }
  },

  setView(view) {
    // 切换视图清空搜索与页码：三类列表的搜索词不通用。
    set({ view, search: '', page: 1 })
  },

  // ufw 一条端口规则在系统里是 v4/v6 两行，而 create/update 的响应只带回首行；
  // 局部追加/替换会让列表落后于系统（看不见的行又让判重报错显得无中生有）。
  // 变更成功后以系统为唯一事实重拉；失败只报通知，列表保持原样。
  async refreshLists(gateway) {
    try {
      const [toggles, rules, ipRules, forwards] = await Promise.all([
        gateway.firewall.toggles(),
        gateway.firewall.list(),
        gateway.firewall.listIpRules(),
        gateway.firewall.listForwards(),
      ])
      set({ toggles, rules, ipRules, forwards })
    } catch (error) {
      notify(error instanceof Error ? `列表同步失败：${error.message}` : '列表同步失败', 'danger')
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
    set({ toggling: true, toggles: next })
    try {
      const confirmed = await gateway.firewall.setToggles(next)
      set({ toggles: confirmed, toggling: false })
      notify(
        next.firewallEnabled !== previous.firewallEnabled
          ? `防火墙已${next.firewallEnabled ? '开启' : '关闭'}${REAL_ACTION_LABEL}`
          : `禁 ping 已${next.pingBlocked ? '开启' : '关闭'}${REAL_ACTION_LABEL}`,
      )
    } catch (error) {
      set({ toggles: previous, toggling: false })
      notify(error instanceof Error ? `切换失败：${error.message}` : '切换失败', 'danger')
    }
  },

  openCreate() {
    set({ dialogRule: 'new' })
  },

  openCreateIp() {
    set({ dialogIpRule: 'new' })
  },

  openCreateForward() {
    set({ dialogForward: 'new' })
  },

  openEdit(rule) {
    set({ dialogRule: rule })
  },

  openEditIp(rule) {
    set({ dialogIpRule: rule })
  },

  openEditForward(rule) {
    set({ dialogForward: rule })
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

  async saveRule(gateway, input) {
    const editing = get().dialogRule
    if (editing === undefined || get().saving) return false
    set({ saving: true })
    try {
      if (editing === 'new') {
        const created = await gateway.firewall.create(input)
        set({ dialogRule: undefined, saving: false })
        notify(`端口规则 ${created.protocol} ${created.port}${created.portTo ? `:${created.portTo}` : ''} 已添加${REAL_ACTION_LABEL}`)
      } else {
        const updated = await gateway.firewall.update(editing.id, input)
        set({ dialogRule: undefined, saving: false })
        notify(`端口规则 ${updated.protocol} ${updated.port}${updated.portTo ? `:${updated.portTo}` : ''} 已修改${REAL_ACTION_LABEL}`)
      }
      // 列表以重拉为准：v4/v6 双生行与时间戳只有系统说得清。
      await get().refreshLists(gateway)
      return true
    } catch (error) {
      set({ saving: false })
      notify(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'danger')
      return false
    }
  },

  async saveIpRule(gateway, input) {
    const editing = get().dialogIpRule
    if (editing === undefined || get().saving) return false
    set({ saving: true })
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
      set({ saving: false })
      notify(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'danger')
      return false
    }
  },

  async saveForward(gateway, input) {
    const editing = get().dialogForward
    if (editing === undefined || get().saving) return false
    set({ saving: true })
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
      set({ saving: false })
      notify(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'danger')
      return false
    }
  },

  async removeRule(gateway, kind, ruleId) {
    if (get().removingRuleIds.includes(ruleId)) return
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
      set((current) => ({ removingRuleIds: current.removingRuleIds.filter((id) => id !== ruleId) }))
      notify(`${label} 已删除${REAL_ACTION_LABEL}`)
      // 删除同样按规范成对移除 v4/v6 双生行，重拉才能反映完整后果。
      await get().refreshLists(gateway)
    } catch (error) {
      set((current) => ({
        removingRuleIds: current.removingRuleIds.filter((id) => id !== ruleId),
      }))
      notify(error instanceof Error ? `删除失败：${error.message}` : '删除失败', 'danger')
    }
  },

  async importRules(gateway, inputs) {
    try {
      const result = await gateway.firewall.importRules(inputs)
      const parts = [`新增 ${result.added.length} 条`]
      if (result.skipped > 0) parts.push(`跳过重复 ${result.skipped} 条`)
      notify(
        result.added.length > 0
          ? `导入完成：${parts.join('，')}${REAL_ACTION_LABEL}`
          : `导入完成：没有新增${result.skipped > 0 ? `，跳过重复 ${result.skipped} 条` : ''}`,
      )
      // 导入是逐条执行的真实命令，重拉把已落地条目如实带回列表。
      await get().refreshLists(gateway)
      return result
    } catch (error) {
      notify(error instanceof Error ? `导入失败：${error.message}` : '导入失败', 'danger')
      return { added: [], skipped: 0 }
    }
  },

  openExport() {
    set({ exportDialogOpen: true })
  },

  closeExport() {
    set({ exportDialogOpen: false })
  },

  // 防扫描数据懒加载：只在第一次打开弹窗时取。
  openScan(gateway) {
    set({ scanDialogOpen: true })
    if (get().scanStatus !== 'idle') return
    set({ scanStatus: 'loading' })
    gateway.firewall
      .scanProtection()
      .then((scanProtection) => set({ scanStatus: 'ready', scanProtection }))
      .catch(() => set({ scanStatus: 'error' }))
  },

  closeScan() {
    set({ scanDialogOpen: false })
  },

  /** 弹窗打开期间的轮询刷新：新出现的封锁 IP 顺手发通知（什么时候拦了谁）。 */
  async refreshScan(gateway) {
    if (get().scanStatus !== 'ready') return
    try {
      const next = await gateway.firewall.scanProtection()
      const known = new Set(get().scanProtection.blocked.map((entry) => entry.ip))
      set({ scanProtection: next })
      for (const entry of next.blocked) {
        if (!known.has(entry.ip)) {
          notify(`防扫描已封锁 IP ${entry.ip}${REAL_ACTION_LABEL}`)
        }
      }
    } catch {
      // 轮询失败静默跳过：下一次轮询会再试。
    }
  },

  async toggleScanProtection(gateway, enabled) {
    const previous = get().scanProtection
    if (previous) set({ scanProtection: { ...previous, enabled } })
    try {
      const next = await gateway.firewall.setScanProtection(enabled)
      set({ scanProtection: next })
      notify(`端口防扫描已${enabled ? '开启' : '关闭'}${REAL_ACTION_LABEL}`)
    } catch {
      if (previous) set({ scanProtection: previous })
      notify('切换防扫描开关失败', 'danger')
    }
  },

  async setScanConfig(gateway, config) {
    try {
      const next = await gateway.firewall.setScanConfig(config)
      set({ scanProtection: next })
      notify(`防扫描配置已更新${REAL_ACTION_LABEL}`)
    } catch (error) {
      notify(error instanceof Error ? `配置失败：${error.message}` : '配置失败', 'danger')
    }
  },

  async unblockIp(gateway, ip) {
    try {
      const next = await gateway.firewall.unblockIp(ip)
      set({ scanProtection: next })
      notify(`已解封 IP ${ip}${REAL_ACTION_LABEL}`)
    } catch (error) {
      notify(error instanceof Error ? `解封失败：${error.message}` : '解封失败', 'danger')
    }
  },

  async syncFromSystem(gateway) {
    if (get().syncing) return
    set({ syncing: true })
    try {
      await gateway.firewall.syncFromSystem()
      // 同步后重拉三类列表，让系统侧（含命令行手敲）的规则进面板。
      await get().load(gateway)
      notify(`已从操作系统同步防火墙规则，当前共 ${get().rules.length + get().ipRules.length + get().forwards.length} 条${REAL_ACTION_LABEL}`)
    } catch (error) {
      notify(error instanceof Error ? `同步失败：${error.message}` : '同步失败', 'danger')
    } finally {
      set({ syncing: false })
    }
  },
}))
