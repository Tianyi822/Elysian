import { captureAuthGeneration } from '../adapters/http/unauthorized'
import { hasUncertainOutcome } from '../adapters/http/requestDeadline'
import type {
  SshAuthMethods,
  SshAuthSettings,
  SshKeyMaterial,
  SshLoginKey,
  SshLoginRecord,
  SshOverview,
  SshRootAuth,
  SshRootLoginPolicy,
} from '@elysian/contracts'
import { isValidSshPort } from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway, SshKeyAccount } from '../contracts/adapters'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import { useMessageStore } from './messageStore'

/** SSH 管理页签的状态：服务概况、登录方式与端口、Root 凭据、登录密钥，以及各分区自己的忙碌态。 */
type SshStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 两张表每页条数：密钥与登录记录同一口径，与防火墙端口规则表一致。 */
export const SSH_PAGE_SIZE = 20

/**
 * 动作完成提示的演示标注：Docker 运行时动作已真实执行 sshd/chpasswd/ssh-keygen，
 * 不再带标注；宿主机本地开发（内存演示）保留。括号形态追加在句子末尾，只用这一个来源。
 */
const MOCK_NOTE = isDockerRuntime() ? '' : 'mock，待接入真实执行'
const MOCK_SUFFIX = MOCK_NOTE ? `（${MOCK_NOTE}）` : ''

export type SshRefreshSection = 'service' | 'root' | 'keys' | 'records'
const SSH_SECTIONS: readonly SshRefreshSection[] = ['service', 'root', 'keys', 'records']
const sectionIdle = () => ({ service: false, root: false, keys: false, records: false })

type SshState = {
  status: SshStatus
  sectionRefreshing: Record<SshRefreshSection, boolean>
  sectionErrors: Partial<Record<SshRefreshSection, string>>
  refreshSection(gateway: ElysianGateway, section: SshRefreshSection, options?: { silent?: boolean }): Promise<void>
  refresh: (gateway: ElysianGateway) => Promise<void>
  clearDisplay: () => void
  errorMessage: string | undefined
  operationError: string | undefined
  overview: SshOverview | undefined
  settings: SshAuthSettings | undefined
  rootAuth: SshRootAuth | undefined
  keys: readonly SshLoginKey[]
  /** 登录记录：只读，登录事实由服务端给出，界面不产生也不修改它。 */
  loginRecords: readonly SshLoginRecord[]
  /** 密钥可归属的账号清单：mock 来自账号数据集，Docker 运行时来自 getent 的真实系统账号。 */
  keyAccounts: readonly SshKeyAccount[]
  /** 端口输入框的草稿。存字符串而不是数字，用户才能把输入清空、也才能输入到一半。 */
  portDraft: string
  portError: string | undefined
  /**
   * 待确认的监听端口：界面层校验通过后停在这里，确认对话据它渲染后果文案，
   * 确认前不动 sshd、也不动防火墙。undefined 表示没有待确认的端口。
   */
  pendingPort: number | undefined
  /** Root 密码草稿；重置成功后清空。密码本身不上屏，也不进任何持久化。 */
  passwordDraft: string
  /** 密钥搜索词：按名称、指纹与私钥内容匹配。 */
  keySearch: string
  /** 两张表各自的页码；删到最后一页空了会被界面收回到有效页。 */
  keyPage: number
  recordPage: number
  createKeyOpen: boolean
  /** 待确认删除的密钥。 */
  removeKeyTarget: SshLoginKey | undefined
  /**
   * 查看密钥弹窗。标题与材料由调用方给定，Root 密钥与登录密钥共用同一个弹窗，
   * 因此这里存的是「要看哪一份」，而不是「要不要打开」。查看只给公钥、指纹与元信息。
   */
  viewKey: { title: string; material: SshKeyMaterial } | undefined
  /**
   * 一次性私钥弹窗：创建登录密钥或生成 Root 密钥成功后打开，材料直接来自那一次响应；
   * 关闭即清空——私钥只在创建/生成那一次可见，之后任何入口都不再返回它。
   * account 是归属账号名，下载文件名以它开头（root 固定为 'root'，登录密钥按 userId 解析）；
   * keyName 是登录密钥创建时填写的名称，进下载文件名紧随账号名（root 密钥没有名称输入）。
   */
  revealKey: { title: string; account: string; keyName?: string; material: SshKeyMaterial } | undefined
  /** Root 密码重置成功后的提醒弹窗：下一次 SSH 登录需要使用新密码。 */
  passwordResetNotice: boolean
  togglingService: boolean
  savingAuth: boolean
  savingPort: boolean
  savingPolicy: boolean
  resettingPassword: boolean
  generatingRootKey: boolean
  creatingKey: boolean
  removingKeyIds: readonly string[]
  load: (gateway: ElysianGateway) => Promise<void>
  setServiceEnabled: (gateway: ElysianGateway, enabled: boolean) => Promise<void>
  setAuthMethod: (gateway: ElysianGateway, patch: Partial<SshAuthMethods>) => Promise<void>
  setPortDraft: (value: string) => void
  requestPortSave: () => void
  cancelPortSave: () => void
  confirmPortSave: (gateway: ElysianGateway) => Promise<void>
  setLoginPolicy: (gateway: ElysianGateway, policy: SshRootLoginPolicy) => Promise<void>
  setPasswordDraft: (value: string) => void
  resetPassword: (gateway: ElysianGateway) => Promise<void>
  createRootKey: (gateway: ElysianGateway) => Promise<void>
  setKeySearch: (search: string) => void
  setKeyPage: (page: number) => void
  setRecordPage: (page: number) => void
  openCreateKey: () => void
  closeCreateKey: () => void
  createKey: (gateway: ElysianGateway, input: { name: string; userId: string }) => Promise<boolean>
  openRemoveKey: (key: SshLoginKey) => void
  closeRemoveKey: () => void
  removeKey: (gateway: ElysianGateway, keyId: string) => Promise<void>
  openKeyView: (title: string, material: SshKeyMaterial) => void
  closeKeyView: () => void
  closeRevealKey: () => void
  closePasswordResetNotice: () => void
}

function notify(message: string, tone: 'success' | 'info' | 'danger' = 'success'): void {
  useMessageStore.getState().notify({ message, tone })
}

/** 入档与查看弹窗的材料不带私钥：私钥只保留在一次性弹窗的那份材料里，列表与查看一律取不到它。 */
function materialWithoutPrivateKey<T extends SshKeyMaterial>(material: T): T {
  const clone = { ...material }
  delete clone.privateKey
  return clone
}

let sshGeneration = 0
let sshRevision = 0

function isBusy(state: SshState): boolean {
  return state.togglingService || state.savingAuth || state.savingPort || state.savingPolicy || state.resettingPassword || state.generatingRootKey || state.creatingKey || state.removingKeyIds.length > 0
}

/** 停服收起设置；一次性私钥保留到用户自行关闭。 */
function stoppedSettings(overview: SshOverview): Partial<SshState> {
  return overview.enabled ? {} : { passwordDraft: '', pendingPort: undefined, createKeyOpen: false, removeKeyTarget: undefined, viewKey: undefined }
}

export const useSshStore = create<SshState>((set, get) => {
  let initialLoad: Promise<void> | undefined
  let settingsRequest = 0
  let appliedSettingsRequest = 0
  const pending = new Map<SshRefreshSection, { gateway: ElysianGateway; generation: number; auth: number; revision: number; promise: Promise<void> }>()
  const applySettings = (settings: SshAuthSettings): Partial<SshState> => {
    const state = get()
    const dirty = state.settings !== undefined && state.portDraft !== String(state.settings.port)
    return { settings, portDraft: dirty ? state.portDraft : String(settings.port) }
  }

  const applyReadSettings = (request: number, settings: SshAuthSettings): Partial<SshState> => {
    if (request < appliedSettingsRequest) return {}
    appliedSettingsRequest = request
    return applySettings(settings)
  }
  const recordFailure = async (error: unknown, gateway: ElysianGateway) => {
    const generation = sshGeneration
    const message = error instanceof Error ? error.message : '操作失败，请重试'
    if (hasUncertainOutcome(error)) await get().load(gateway)
    if (generation === sshGeneration) set({ operationError: message })
  }
  return ({
  status: 'idle',
  sectionRefreshing: sectionIdle(),
  sectionErrors: {},
  errorMessage: undefined,
  operationError: undefined,
  overview: undefined,
  settings: undefined,
  rootAuth: undefined,
  keys: [],
  loginRecords: [],
  keyAccounts: [],
  portDraft: '',
  portError: undefined,
  pendingPort: undefined,
  passwordDraft: '',
  keySearch: '',
  keyPage: 1,
  recordPage: 1,
  createKeyOpen: false,
  removeKeyTarget: undefined,
  viewKey: undefined,
  revealKey: undefined,
  passwordResetNotice: false,
  togglingService: false,
  savingAuth: false,
  savingPort: false,
  savingPolicy: false,
  resettingPassword: false,
  generatingRootKey: false,
  creatingKey: false,
  removingKeyIds: [],

  clearDisplay() {
    sshGeneration += 1
    sshRevision += 1
    pending.clear()
    initialLoad = undefined
    settingsRequest += 1
    appliedSettingsRequest = settingsRequest
    set(useSshStore.getInitialState())
  },

  async refresh(gateway) {
    if (get().status !== 'ready') return
    await Promise.all(['service', 'records'].map(section => get().refreshSection(gateway, section as SshRefreshSection, { silent: true })))
  },

  refreshSection(gateway, section, options) {
    if (isBusy(get())) return Promise.resolve()
    const generation = sshGeneration, revision = sshRevision, auth = captureAuthGeneration()
    const previous = pending.get(section)
    if (previous?.gateway === gateway && previous.generation === generation && previous.auth === auth && previous.revision === revision) {
      if (!options?.silent) set(state => ({ sectionRefreshing: { ...state.sectionRefreshing, [section]: true } }))
      return previous.promise
    }
    const current = () => generation === sshGeneration && auth === captureAuthGeneration() && revision === sshRevision
    const setting = section === 'service' || section === 'root' ? ++settingsRequest : 0
    const operation = { gateway, generation, revision, auth, promise: Promise.resolve() }
    pending.set(section, operation)
    set(state => ({ sectionRefreshing: { ...state.sectionRefreshing, [section]: !options?.silent }, sectionErrors: { ...state.sectionErrors, [section]: undefined } }))
    operation.promise = (async () => {
      if (section === 'service') {
        const [overview, settings] = await Promise.all([gateway.ssh.overview(), gateway.ssh.settings()])
        if (current()) set({ overview, ...applyReadSettings(setting, settings), ...stoppedSettings(overview) })
      } else if (section === 'root') {
        const [rootAuth, settings] = await Promise.all([gateway.ssh.rootAuth(), gateway.ssh.settings()])
        if (current()) set({ rootAuth, ...applyReadSettings(setting, settings) })
      } else if (section === 'keys') {
        const [keys, keyAccounts] = await Promise.all([gateway.ssh.listKeys(), gateway.ssh.keyAccounts()])
        if (current()) set({ keys, keyAccounts })
      } else {
        const loginRecords = await gateway.ssh.listLoginRecords()
        if (current()) set({ loginRecords })
      }
    })().catch(error => {
      if (current()) set(state => ({ sectionErrors: { ...state.sectionErrors, [section]: error instanceof Error ? error.message : 'SSH 数据刷新失败' } }))
    }).finally(() => {
      if (pending.get(section) !== operation) return
      pending.delete(section)
      if (generation === sshGeneration && auth === captureAuthGeneration()) set(state => ({ sectionRefreshing: { ...state.sectionRefreshing, [section]: false } }))
    })
    return operation.promise
  },

  load(gateway) {
    if (get().overview !== undefined) return Promise.all(SSH_SECTIONS.map(section => get().refreshSection(gateway, section, { silent: true }))).then(() => {})
    if (initialLoad) return initialLoad
    if (isBusy(get())) return Promise.resolve()
    const generation = sshGeneration, revision = sshRevision, auth = captureAuthGeneration()
    const current = () => generation === sshGeneration && revision === sshRevision && auth === captureAuthGeneration()
    set({ status: 'loading', errorMessage: undefined })
    let operation!: Promise<void>
    operation = (async () => {
      try {
        const [overview, settings, rootAuth, keys, loginRecords, keyAccounts] = await Promise.all([
          gateway.ssh.overview(), gateway.ssh.settings(), gateway.ssh.rootAuth(), gateway.ssh.listKeys(), gateway.ssh.listLoginRecords(), gateway.ssh.keyAccounts(),
        ])
        if (current()) set({ status: 'ready', operationError: undefined, overview, ...applySettings(settings), rootAuth, keys, loginRecords, keyAccounts, ...stoppedSettings(overview) })
      } catch (error) {
        if (current()) set({ status: 'error', errorMessage: error instanceof Error ? error.message : 'SSH 数据加载失败' })
      } finally { if (initialLoad === operation) initialLoad = undefined }
    })()
    initialLoad = operation
    return operation
  },

  // 服务开关等待后端确认，避免停服失败时先收起配置。
  async setServiceEnabled(gateway, enabled) {
    if (isBusy(get())) return
    const generation = sshGeneration
    const previous = get().overview
    if (!previous || get().togglingService) return
    set({
      togglingService: true,
      operationError: undefined,
    })
    sshRevision += 1
    try {
      const confirmed = await gateway.ssh.setServiceEnabled(enabled)
      if (generation !== sshGeneration) return
      set({ overview: confirmed, togglingService: false, ...stoppedSettings(confirmed) })
      notify(`SSH 服务已${confirmed.enabled ? '启用' : '停用'}${MOCK_SUFFIX}`)
    } catch (error) {
      if (generation !== sshGeneration) return
      set({ overview: previous, togglingService: false })
      notify(error instanceof Error ? `切换失败：${error.message}` : '切换失败', 'danger')
      await recordFailure(error, gateway)
    }
  },

  async setAuthMethod(gateway, patch) {
    if (isBusy(get())) return
    const generation = sshGeneration
    const previous = get().settings
    if (!previous || get().savingAuth) return
    set({ savingAuth: true, settings: { ...previous, ...patch } })
    sshRevision += 1
    try {
      const confirmed = await gateway.ssh.setAuthMethods({ ...previous, ...patch })
      if (generation !== sshGeneration) return
      set({ settings: confirmed, savingAuth: false })
      const label =
        patch.passwordAuthEnabled !== undefined
          ? `SSH 密码登录已${confirmed.passwordAuthEnabled ? '开启' : '关闭'}`
          : `SSH 密钥登录已${confirmed.keyAuthEnabled ? '开启' : '关闭'}`
      notify(`${label}${MOCK_SUFFIX}`)
    } catch (error) {
      if (generation !== sshGeneration) return
      set({ settings: previous, savingAuth: false })
      notify(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'danger')
      await recordFailure(error, gateway)
    }
  },

  setPortDraft(value) {
    set({ portDraft: value, portError: undefined })
  },

  // 非法端口在界面层就挡下，不发请求；合法才停下来等确认，adapter 那里用同一判据再挡一次。
  requestPortSave() {
    const draft = get().portDraft.trim()
    const next = Number(draft)
    if (!isValidSshPort(next)) {
      set({ portError: '端口需为 1-65535 的整数' })
      return
    }
    set({ portError: undefined, pendingPort: next })
  },

  cancelPortSave() {
    set({ pendingPort: undefined })
  },

  // 确认后提交服务端事务；防火墙检查与监听切换由同一请求完成。
  async confirmPortSave(gateway) {
    if (isBusy(get())) return
    const generation = sshGeneration
    const next = get().pendingPort
    if (next === undefined || get().savingPort) return
    set({ savingPort: true, operationError: undefined })
    let firewallPort: SshAuthSettings['firewallPort']
    sshRevision += 1
    try {
      const confirmed = await gateway.ssh.setPort(next)
      if (generation !== sshGeneration) return
      firewallPort = confirmed.firewallPort
      set({
        settings: confirmed,
        portDraft: `${confirmed.port}`,
        savingPort: false,
        pendingPort: undefined,
      })
      notify(`SSH 端口已改为 ${confirmed.port}${MOCK_SUFFIX}`)
    } catch (error) {
      if (generation !== sshGeneration) return
      // 端口没改成：保留确认对话与行内原因，同时记录失败消息。
      set({ savingPort: false })
      notify(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'danger')
      await recordFailure(error, gateway)
      return
    }
    if (firewallPort) {
      notify(firewallPort.state === 'opened' ? `已为新端口 ${firewallPort.port} 添加防火墙 tcp 放行规则${MOCK_SUFFIX}` : firewallPort.detail ?? '请核对防火墙规则', firewallPort.state === 'failed' ? 'danger' : firewallPort.state === 'skipped' ? 'info' : 'success')
    } else {
      notify('服务端未返回防火墙联动结果，请到防火墙页确认新端口已放行', 'info')
    }
  },

  async setLoginPolicy(gateway, policy) {
    if (isBusy(get())) return
    const generation = sshGeneration
    const previous = get().rootAuth
    if (!previous || get().savingPolicy) return
    set({ savingPolicy: true, rootAuth: { ...previous, policy } })
    sshRevision += 1
    try {
      const confirmed = await gateway.ssh.saveRootLoginPolicy(policy)
      if (generation !== sshGeneration) return
      set({ rootAuth: confirmed, savingPolicy: false })
      notify(`Root 登录已${policy === 'no' ? '禁止' : '允许'}${MOCK_SUFFIX}`)
    } catch (error) {
      if (generation !== sshGeneration) return
      set({ rootAuth: previous, savingPolicy: false })
      notify(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'danger')
      await recordFailure(error, gateway)
    }
  },

  setPasswordDraft(value) {
    set({ passwordDraft: value })
  },

  // 空输入不发请求；判定为弱密码由服务侧拒绝（mock 与容器内 chpasswd 前的复验同一次判定），消息直接来自那一次判定。
  async resetPassword(gateway) {
    if (isBusy(get())) return
    const generation = sshGeneration
    const password = get().passwordDraft
    if (!password) {
      set({ operationError: '请输入新的 Root 密码' })
      return
    }
    if (get().resettingPassword) return
    set({ resettingPassword: true, operationError: undefined })
    sshRevision += 1
    try {
      const result = await gateway.ssh.resetRootPassword(password)
      if (generation !== sshGeneration) return
      set({ rootAuth: result.auth, passwordDraft: '', resettingPassword: false, passwordResetNotice: true })
      notify(`Root 密码已重置${MOCK_SUFFIX}`)
    } catch (error) {
      if (generation !== sshGeneration) return
      set({ resettingPassword: false })
      notify(error instanceof Error ? `重置失败：${error.message}` : '重置失败', 'danger')
      await recordFailure(error, gateway)
    }
  },

  closePasswordResetNotice() {
    set({ passwordResetNotice: false })
  },

  // 生成（或重新生成）Root 密钥：私钥只进一次性弹窗，入档的 rootAuth 不带它。
  async createRootKey(gateway) {
    if (isBusy(get())) return
    const generation = sshGeneration
    const hadKey = get().rootAuth?.key != null
    if (get().generatingRootKey) return
    set({ generatingRootKey: true })
    sshRevision += 1
    try {
      const result = await gateway.ssh.createRootKey()
      if (generation !== sshGeneration) return
      set({
        rootAuth: {
          ...result,
          key: result.key ? materialWithoutPrivateKey(result.key) : null,
        },
        revealKey: result.key
          ? { title: 'Root 密钥已生成', account: 'root', material: result.key }
          : undefined,
        generatingRootKey: false,
      })
      notify(`Root 密钥已${hadKey ? '重新生成' : '生成'}${MOCK_SUFFIX}`)
    } catch (error) {
      if (generation !== sshGeneration) return
      set({ generatingRootKey: false })
      notify(error instanceof Error ? `生成失败：${error.message}` : '生成失败', 'danger')
      await recordFailure(error, gateway)
    }
  },

  openKeyView(title, material) {
    // 查看入口只给公钥、指纹与元信息：即便上游材料带了私钥，这里也不让它进查看弹窗。
    set({ viewKey: { title, material: materialWithoutPrivateKey(material) } })
  },

  closeKeyView() {
    set({ viewKey: undefined })
  },

  closeRevealKey() {
    // 关闭即清空：一次性私钥从内存状态里消失，此后没有任何入口能再取回它。
    set({ revealKey: undefined })
  },

  setKeySearch(search) {
    // 换了搜索词就回到第一页：结果集变了，停在第 3 页会落到空页上。
    set({ keySearch: search, keyPage: 1 })
  },

  setKeyPage(page) {
    set({ keyPage: page })
  },

  setRecordPage(page) {
    set({ recordPage: page })
  },

  openCreateKey() {
    set({ createKeyOpen: true, operationError: undefined })
  },

  closeCreateKey() {
    set({ createKeyOpen: false, creatingKey: false })
  },

  // 创建成功返回 true，弹窗据此关闭；失败保留弹窗与已填名称。
  async createKey(gateway, input) {
    if (isBusy(get())) return false
    const generation = sshGeneration
    if (get().creatingKey) return false
    set({ creatingKey: true, operationError: undefined })
    sshRevision += 1
    try {
      const created = await gateway.ssh.createKey(input)
      if (generation !== sshGeneration) return false
      set((state) => ({
        // 入列的条目不带私钥；那一份只进一次性弹窗，关闭即清空。
        keys: [...state.keys, materialWithoutPrivateKey(created)],
        createKeyOpen: false,
        creatingKey: false,
        revealKey: {
          title: `新密钥「${created.name}」的私钥`,
          account:
            state.keyAccounts.find((entry) => entry.id === created.userId)?.name ?? created.userId,
          keyName: created.name,
          material: created,
        },
      }))
      notify(`SSH 密钥「${created.name}」已创建${MOCK_SUFFIX}`)
      return true
    } catch (error) {
      if (generation !== sshGeneration) return false
      set({ creatingKey: false })
      notify(error instanceof Error ? `创建失败：${error.message}` : '创建失败', 'danger')
      await recordFailure(error, gateway)
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
    if (isBusy(get())) return
    const generation = sshGeneration
    const target = get().keys.find((key) => key.id === keyId)
    if (!target || get().removingKeyIds.includes(keyId)) return
    set((state) => ({ removingKeyIds: [...state.removingKeyIds, keyId] }))
    sshRevision += 1
    try {
      await gateway.ssh.removeKey(keyId)
      if (generation !== sshGeneration) return
      set((state) => ({
        keys: state.keys.filter((key) => key.id !== keyId),
        removingKeyIds: state.removingKeyIds.filter((id) => id !== keyId),
      }))
      notify(`SSH 密钥「${target.name}」已删除${MOCK_SUFFIX}`)
    } catch (error) {
      if (generation !== sshGeneration) return
      set((state) => ({
        removingKeyIds: state.removingKeyIds.filter((id) => id !== keyId),
      }))
      notify(error instanceof Error ? `删除失败：${error.message}` : '删除失败', 'danger')
      await recordFailure(error, gateway)
    }
  },
})
})
