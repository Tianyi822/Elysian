import type {
  FirewallImportResult,
  FirewallRule,
  FirewallRuleInput,
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

type FirewallStatus = 'idle' | 'loading' | 'ready' | 'error'

type FirewallState = {
  status: FirewallStatus
  errorMessage: string | undefined
  rules: readonly FirewallRule[]
  toggles: FirewallToggles
  /** 搜索按端口、来源与备注匹配；变化时回到第一页。 */
  search: string
  page: number
  /** 弹窗状态：editing 为 null 表示新建，非 null 表示在改这条规则。 */
  dialogRule: FirewallRule | 'new' | undefined
  /** 待确认删除的规则；确认弹窗据此渲染。 */
  removeTarget: FirewallRule | undefined
  /** 防扫描弹窗：数据在首次打开时懒加载。 */
  scanDialogOpen: boolean
  scanStatus: 'idle' | 'loading' | 'ready' | 'error'
  scanProtection: FirewallScanProtection | undefined
  /** 导出方向选择弹窗。 */
  exportDialogOpen: boolean
  /** 同步规则的忙碌态。 */
  syncing: boolean
  saving: boolean
  removingRuleIds: readonly string[]
  load: (gateway: ElysianGateway) => Promise<void>
  setSearch: (search: string) => void
  setPage: (page: number) => void
  toggle: (gateway: ElysianGateway, next: FirewallToggles) => Promise<void>
  openCreate: () => void
  openEdit: (rule: FirewallRule) => void
  closeDialog: () => void
  openRemove: (rule: FirewallRule) => void
  closeRemove: () => void
  saveRule: (gateway: ElysianGateway, input: FirewallRuleInput) => Promise<boolean>
  removeRule: (gateway: ElysianGateway, ruleId: string) => Promise<void>
  importRules: (gateway: ElysianGateway, inputs: readonly FirewallRuleInput[]) => Promise<FirewallImportResult>
  openExport: () => void
  closeExport: () => void
  openScan: (gateway: ElysianGateway) => void
  closeScan: () => void
  toggleScanProtection: (gateway: ElysianGateway, enabled: boolean) => Promise<void>
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
  toggles: { firewallEnabled: true, pingBlocked: true },
  search: '',
  page: 1,
  dialogRule: undefined,
  removeTarget: undefined,
  scanDialogOpen: false,
  scanStatus: 'idle',
  scanProtection: undefined,
  exportDialogOpen: false,
  syncing: false,
  saving: false,
  removingRuleIds: [],

  async load(gateway) {
    if (get().status === 'loading') return
    set({ status: 'loading', errorMessage: undefined })
    try {
      const [rules, toggles] = await Promise.all([gateway.firewall.list(), gateway.firewall.toggles()])
      set({ status: 'ready', rules, toggles })
    } catch (error) {
      set({ status: 'error', errorMessage: error instanceof Error ? error.message : '防火墙数据加载失败' })
    }
  },

  setSearch(search) {
    set({ search, page: 1 })
  },

  setPage(page) {
    set({ page })
  },

  // 乐观更新：开关先翻再等 adapter 确认，失败回滚并报危险通知。
  async toggle(gateway, next) {
    const previous = get().toggles
    set({ toggles: next })
    try {
      const confirmed = await gateway.firewall.setToggles(next)
      set({ toggles: confirmed })
      notify(
        next.firewallEnabled !== previous.firewallEnabled
          ? `防火墙已${next.firewallEnabled ? '开启' : '关闭'}${REAL_ACTION_LABEL}`
          : `禁 ping 已${next.pingBlocked ? '开启' : '关闭'}${REAL_ACTION_LABEL}`,
      )
    } catch (error) {
      set({ toggles: previous })
      notify(error instanceof Error ? `切换失败：${error.message}` : '切换失败', 'danger')
    }
  },

  openCreate() {
    set({ dialogRule: 'new' })
  },

  openEdit(rule) {
    set({ dialogRule: rule })
  },

  closeDialog() {
    set({ dialogRule: undefined, saving: false })
  },

  openRemove(rule) {
    set({ removeTarget: rule })
  },

  closeRemove() {
    set({ removeTarget: undefined })
  },

  // 保存成功返回 true，弹窗据此关闭；失败保留弹窗与填写内容。
  async saveRule(gateway, input) {
    const editing = get().dialogRule
    if (editing === undefined || get().saving) return false
    set({ saving: true })
    try {
      if (editing === 'new') {
        const created = await gateway.firewall.create(input)
        set((state) => ({ rules: [...state.rules, created], dialogRule: undefined, saving: false }))
        notify(`端口规则 ${created.protocol} ${created.port} 已添加${REAL_ACTION_LABEL}`)
      } else {
        const updated = await gateway.firewall.update(editing.id, input)
        set((state) => ({
          rules: state.rules.map((rule) => (rule.id === updated.id ? updated : rule)),
          dialogRule: undefined,
          saving: false,
        }))
        notify(`端口规则 ${updated.protocol} ${updated.port} 已修改${REAL_ACTION_LABEL}`)
      }
      return true
    } catch (error) {
      set({ saving: false })
      notify(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'danger')
      return false
    }
  },

  async removeRule(gateway, ruleId) {
    const target = get().rules.find((rule) => rule.id === ruleId)
    if (!target || get().removingRuleIds.includes(ruleId)) return
    set((state) => ({ removingRuleIds: [...state.removingRuleIds, ruleId] }))
    try {
      await gateway.firewall.remove(ruleId)
      set((state) => ({
        rules: state.rules.filter((rule) => rule.id !== ruleId),
        removingRuleIds: state.removingRuleIds.filter((id) => id !== ruleId),
      }))
      notify(`端口规则 ${target.protocol} ${target.port} 已删除${REAL_ACTION_LABEL}`)
    } catch (error) {
      set((state) => ({
        removingRuleIds: state.removingRuleIds.filter((id) => id !== ruleId),
      }))
      notify(error instanceof Error ? `删除失败：${error.message}` : '删除失败', 'danger')
    }
  },

  async importRules(gateway, inputs) {
    try {
      const result = await gateway.firewall.importRules(inputs)
      set((state) => ({ rules: [...state.rules, ...result.added] }))
      const parts = [`新增 ${result.added.length} 条`]
      if (result.skipped > 0) parts.push(`跳过重复 ${result.skipped} 条`)
      notify(
        result.added.length > 0
          ? `导入完成：${parts.join('，')}${REAL_ACTION_LABEL}`
          : `导入完成：没有新增${result.skipped > 0 ? `，跳过重复 ${result.skipped} 条` : ''}`,
      )
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
      const { total } = await gateway.firewall.syncFromSystem()
      notify(`已从操作系统同步端口规则，当前共 ${total} 条${REAL_ACTION_LABEL}`)
    } catch (error) {
      notify(error instanceof Error ? `同步失败：${error.message}` : '同步失败', 'danger')
    } finally {
      set({ syncing: false })
    }
  },
}))
