import type {
  SshAuthMethods,
  SshAuthSettings,
  SshKeyMaterial,
  SshLoginKey,
  SshOverview,
  SshRootAuth,
  SshRootLoginPolicy,
} from '@elysian/contracts'
import { SSH_PASSWORD_STRENGTH_LABELS, SSH_ROOT_LOGIN_POLICY_LABELS, isValidSshPort } from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from './notificationStore'

/** SSH 管理页签的状态：服务概况、登录方式与端口、Root 凭据、登录密钥，以及各分区自己的忙碌态。 */
type SshStatus = 'idle' | 'loading' | 'ready' | 'error'

type SshState = {
  status: SshStatus
  errorMessage: string | undefined
  overview: SshOverview | undefined
  settings: SshAuthSettings | undefined
  rootAuth: SshRootAuth | undefined
  keys: readonly SshLoginKey[]
  /** 端口输入框的草稿。存字符串而不是数字，用户才能把输入清空、也才能输入到一半。 */
  portDraft: string
  portError: string | undefined
  /** Root 密码草稿；重置成功后清空。密码本身不上屏，也不进任何持久化。 */
  passwordDraft: string
  /** 密钥搜索词：按名称、指纹与私钥内容匹配。 */
  keySearch: string
  createKeyOpen: boolean
  /** 待确认删除的密钥。 */
  removeKeyTarget: SshLoginKey | undefined
  /**
   * 查看密钥弹窗。标题与材料由调用方给定，Root 密钥与登录密钥共用同一个弹窗，
   * 因此这里存的是「要看哪一份」，而不是「要不要打开」。
   */
  viewKey: { title: string; material: SshKeyMaterial } | undefined
  togglingService: boolean
  savingAuth: boolean
  savingPort: boolean
  savingPolicy: boolean
  resettingPassword: boolean
  creatingKey: boolean
  removingKeyIds: readonly string[]
  load: (gateway: ElysianGateway) => Promise<void>
  setServiceEnabled: (gateway: ElysianGateway, enabled: boolean) => Promise<void>
  setAuthMethod: (gateway: ElysianGateway, patch: Partial<SshAuthMethods>) => Promise<void>
  setPortDraft: (value: string) => void
  savePort: (gateway: ElysianGateway) => Promise<void>
  setLoginPolicy: (gateway: ElysianGateway, policy: SshRootLoginPolicy) => Promise<void>
  setPasswordDraft: (value: string) => void
  resetPassword: (gateway: ElysianGateway) => Promise<void>
  setKeySearch: (search: string) => void
  openCreateKey: () => void
  closeCreateKey: () => void
  createKey: (gateway: ElysianGateway, input: { name: string }) => Promise<boolean>
  openRemoveKey: (key: SshLoginKey) => void
  closeRemoveKey: () => void
  removeKey: (gateway: ElysianGateway, keyId: string) => Promise<void>
  openKeyView: (title: string, material: SshKeyMaterial) => void
  closeKeyView: () => void
}

function notify(message: string, tone: 'success' | 'info' | 'danger' = 'success'): void {
  useNotificationStore.getState().notify({ message, tone })
}

export const useSshStore = create<SshState>((set, get) => ({
  status: 'idle',
  errorMessage: undefined,
  overview: undefined,
  settings: undefined,
  rootAuth: undefined,
  keys: [],
  portDraft: '',
  portError: undefined,
  passwordDraft: '',
  keySearch: '',
  createKeyOpen: false,
  removeKeyTarget: undefined,
  viewKey: undefined,
  togglingService: false,
  savingAuth: false,
  savingPort: false,
  savingPolicy: false,
  resettingPassword: false,
  creatingKey: false,
  removingKeyIds: [],

  async load(gateway) {
    if (get().status === 'loading') return
    set({ status: 'loading', errorMessage: undefined })
    try {
      const [overview, settings, rootAuth, keys] = await Promise.all([
        gateway.ssh.overview(),
        gateway.ssh.settings(),
        gateway.ssh.rootAuth(),
        gateway.ssh.listKeys(),
      ])
      set({ status: 'ready', overview, settings, rootAuth, keys, portDraft: `${settings.port}` })
    } catch (error) {
      set({ status: 'error', errorMessage: error instanceof Error ? error.message : 'SSH 数据加载失败' })
    }
  },

  // 乐观更新：开关先翻再等 mock 确认，失败回滚并报危险通知。
  async setServiceEnabled(gateway, enabled) {
    const previous = get().overview
    if (!previous || get().togglingService) return
    set({
      togglingService: true,
      overview: { ...previous, enabled, status: enabled ? 'running' : 'stopped' },
    })
    try {
      const confirmed = await gateway.ssh.setServiceEnabled(enabled)
      set({ overview: confirmed, togglingService: false })
      notify(`SSH 服务已${enabled ? '启用' : '停用'}（mock，待接入真实执行）`)
    } catch (error) {
      set({ overview: previous, togglingService: false })
      notify(error instanceof Error ? `切换失败：${error.message}` : '切换失败', 'danger')
    }
  },

  async setAuthMethod(gateway, patch) {
    const previous = get().settings
    if (!previous || get().savingAuth) return
    set({ savingAuth: true, settings: { ...previous, ...patch } })
    try {
      const confirmed = await gateway.ssh.setAuthMethods({ ...previous, ...patch })
      set({ settings: confirmed, savingAuth: false })
      const label =
        patch.passwordAuthEnabled !== undefined
          ? `SSH 密码登录已${confirmed.passwordAuthEnabled ? '开启' : '关闭'}`
          : `SSH 密钥登录已${confirmed.keyAuthEnabled ? '开启' : '关闭'}`
      notify(`${label}（mock，待接入真实执行）`)
    } catch (error) {
      set({ settings: previous, savingAuth: false })
      notify(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'danger')
    }
  },

  setPortDraft(value) {
    set({ portDraft: value, portError: undefined })
  },

  // 非法端口在界面层就挡下，不发请求；合法才交给 adapter，那里用同一判据再挡一次。
  async savePort(gateway) {
    const draft = get().portDraft.trim()
    if (!isValidSshPort(Number(draft))) {
      set({ portError: '端口需为 1-65535 的整数' })
      return
    }
    if (get().savingPort) return
    set({ savingPort: true })
    try {
      const confirmed = await gateway.ssh.setPort(Number(draft))
      set({ settings: confirmed, portDraft: `${confirmed.port}`, savingPort: false })
      notify(`SSH 端口已改为 ${confirmed.port}（mock，待接入真实执行）`)
    } catch (error) {
      set({ savingPort: false })
      notify(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'danger')
    }
  },

  async setLoginPolicy(gateway, policy) {
    const previous = get().rootAuth
    if (!previous || get().savingPolicy) return
    set({ savingPolicy: true, rootAuth: { ...previous, policy } })
    try {
      const confirmed = await gateway.ssh.saveRootLoginPolicy(policy)
      set({ rootAuth: confirmed, savingPolicy: false })
      notify(`Root 登录策略已改为「${SSH_ROOT_LOGIN_POLICY_LABELS[policy]}」（mock，待接入真实执行）`)
    } catch (error) {
      set({ rootAuth: previous, savingPolicy: false })
      notify(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'danger')
    }
  },

  setPasswordDraft(value) {
    set({ passwordDraft: value })
  },

  // 空输入不发请求；判定为弱密码由 mock 侧拒绝，消息直接来自那一次判定。
  async resetPassword(gateway) {
    const password = get().passwordDraft
    if (!password) {
      notify('请输入新的 Root 密码', 'danger')
      return
    }
    if (get().resettingPassword) return
    set({ resettingPassword: true })
    try {
      const result = await gateway.ssh.resetRootPassword(password)
      set({ rootAuth: result.auth, passwordDraft: '', resettingPassword: false })
      notify(
        `Root 密码已重置（强度：${SSH_PASSWORD_STRENGTH_LABELS[result.strength]}；mock，待接入真实执行）`,
      )
    } catch (error) {
      set({ resettingPassword: false })
      notify(error instanceof Error ? `重置失败：${error.message}` : '重置失败', 'danger')
    }
  },

  openKeyView(title, material) {
    set({ viewKey: { title, material } })
  },

  closeKeyView() {
    set({ viewKey: undefined })
  },

  setKeySearch(search) {
    set({ keySearch: search })
  },

  openCreateKey() {
    set({ createKeyOpen: true })
  },

  closeCreateKey() {
    set({ createKeyOpen: false, creatingKey: false })
  },

  // 创建成功返回 true，弹窗据此关闭；失败保留弹窗与已填名称。
  async createKey(gateway, input) {
    if (get().creatingKey) return false
    set({ creatingKey: true })
    try {
      const created = await gateway.ssh.createKey(input)
      set((state) => ({
        keys: [...state.keys, created],
        createKeyOpen: false,
        creatingKey: false,
      }))
      notify(`SSH 密钥「${created.name}」已创建（mock，待接入真实执行）`)
      return true
    } catch (error) {
      set({ creatingKey: false })
      notify(error instanceof Error ? `创建失败：${error.message}` : '创建失败', 'danger')
      return false
    }
  },

  openRemoveKey(key) {
    set({ removeKeyTarget: key })
  },

  closeRemoveKey() {
    set({ removeKeyTarget: undefined })
  },

  async removeKey(gateway, keyId) {
    const target = get().keys.find((key) => key.id === keyId)
    if (!target || get().removingKeyIds.includes(keyId)) return
    set((state) => ({ removingKeyIds: [...state.removingKeyIds, keyId] }))
    try {
      await gateway.ssh.removeKey(keyId)
      set((state) => ({
        keys: state.keys.filter((key) => key.id !== keyId),
        removingKeyIds: state.removingKeyIds.filter((id) => id !== keyId),
      }))
      notify(`SSH 密钥「${target.name}」已删除（mock，待接入真实执行）`)
    } catch (error) {
      set((state) => ({
        removingKeyIds: state.removingKeyIds.filter((id) => id !== keyId),
      }))
      notify(error instanceof Error ? `删除失败：${error.message}` : '删除失败', 'danger')
    }
  },
}))
