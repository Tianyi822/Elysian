import type {
  FirewallRule,
  FirewallToggles,
  SshAuthMethods,
  SshAuthSettings,
  SshKeyMaterial,
  SshLoginKey,
  SshLoginRecord,
  SshOverview,
  SshRootAuth,
  SshRootLoginPolicy,
} from '@elysian/contracts'
import { FIREWALL_POLICY_LABELS, isValidSshPort } from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway, SshKeyAccount } from '../contracts/adapters'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import { useNotificationStore } from './notificationStore'

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

type SshState = {
  status: SshStatus
  errorMessage: string | undefined
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
  useNotificationStore.getState().notify({ message, tone })
}

/** 入档与查看弹窗的材料不带私钥：私钥只保留在一次性弹窗的那份材料里，列表与查看一律取不到它。 */
function materialWithoutPrivateKey<T extends SshKeyMaterial>(material: T): T {
  const clone = { ...material }
  delete clone.privateKey
  return clone
}

/** 联动补出的规则在这里署名：防火墙页里一眼看出这条是谁加的，不是手敲的。 */
const SSH_PORT_LINK_NOTE = 'SSH 端口联动放行'

/**
 * 改端口后的防火墙联动：防火墙启用时给新端口补一条 tcp 入站放行，否则 sshd 在新端口上照旧被挡在外面。
 * 旧端口的规则保留不动——面板不替用户删规则，需要时到防火墙页自行清理。
 * 复用防火墙 adapter（gateway.firewall），SSH 服务侧不感知防火墙，方向只从编排层指向它。
 * 结果只经通知如实报出：端口本身已经保存成功，联动失败不回滚它，而是给出手动放行的指引。
 * 读防火墙状态（toggles/list）与写放行规则一样属于联动的一部分，同样在这里收尾——
 * 任何一步失败都只报联动失败，绝不冒用「保存失败」把已经成功的端口说成没保存。
 */
async function linkSshPortToFirewall(gateway: ElysianGateway, port: number): Promise<void> {
  let toggles: FirewallToggles
  let rules: readonly FirewallRule[]
  try {
    toggles = await gateway.firewall.toggles()
    rules = toggles.firewallEnabled ? await gateway.firewall.list() : []
  } catch (error) {
    notify(
      `端口已改为 ${port}，但防火墙联动检查失败：${
        error instanceof Error ? error.message : '未知原因'
      }。请到防火墙页确认 ${port}/tcp 已放行，否则 SSH 无法连接`,
      'danger',
    )
    return
  }
  if (!toggles.firewallEnabled) {
    notify('防火墙当前未启用：新端口未联动放行，启用防火墙前请自行确认放行', 'info')
    return
  }
  // 只看与新端口同协议同地址族的入站规则：端口段（portTo）与出站规则管不到新端口。
  const existing = rules.find(
    (rule) => rule.protocol === 'tcp' && rule.port === port && rule.portTo === null && rule.family === 'ipv4',
  )
  if (existing) {
    notify(
      existing.policy === 'deny'
        ? `端口已改为 ${port}，但防火墙上该端口已有拒绝规则，未添加放行：请先到防火墙页处理，否则 SSH 无法连接`
        : `防火墙已有 ${port}/tcp 的${FIREWALL_POLICY_LABELS[existing.policy]}规则，无需重复添加`,
      existing.policy === 'deny' ? 'danger' : 'success',
    )
    return
  }
  try {
    await gateway.firewall.create({
      protocol: 'tcp',
      port,
      family: 'ipv4',
      policy: 'allow',
      direction: 'inbound',
      source: '所有IP',
      note: SSH_PORT_LINK_NOTE,
    })
    notify(`已为新端口 ${port} 添加防火墙 tcp 放行规则${MOCK_SUFFIX}`)
  } catch (error) {
    notify(
      `端口已改为 ${port}，但防火墙放行失败：${
        error instanceof Error ? error.message : '未知原因'
      }。请到防火墙页手动放行，否则 SSH 无法连接`,
      'danger',
    )
  }
}

export const useSshStore = create<SshState>((set, get) => ({
  status: 'idle',
  errorMessage: undefined,
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

  async load(gateway) {
    if (get().status === 'loading') return
    set({ status: 'loading', errorMessage: undefined })
    try {
      const [overview, settings, rootAuth, keys, loginRecords, keyAccounts] = await Promise.all([
        gateway.ssh.overview(),
        gateway.ssh.settings(),
        gateway.ssh.rootAuth(),
        gateway.ssh.listKeys(),
        gateway.ssh.listLoginRecords(),
        gateway.ssh.keyAccounts(),
      ])
      set({
        status: 'ready',
        overview,
        settings,
        rootAuth,
        keys,
        loginRecords,
        keyAccounts,
        portDraft: `${settings.port}`,
        // 重新拉数据即丢弃未确认的端口草稿：界面上摆着的确认对话不该跨过一次重新加载。
        pendingPort: undefined,
      })
    } catch (error) {
      set({ status: 'error', errorMessage: error instanceof Error ? error.message : 'SSH 数据加载失败' })
    }
  },

  // 乐观更新：开关先翻再等 adapter 确认，失败回滚并报危险通知。
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
      notify(`SSH 服务已${enabled ? '启用' : '停用'}${MOCK_SUFFIX}`)
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
      notify(`${label}${MOCK_SUFFIX}`)
    } catch (error) {
      set({ settings: previous, savingAuth: false })
      notify(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'danger')
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

  // 确认后才落袋：先改 sshd，再按防火墙当前状态决定放不放行新端口。
  async confirmPortSave(gateway) {
    const next = get().pendingPort
    if (next === undefined || get().savingPort) return
    set({ savingPort: true })
    let savedPort: number
    try {
      const confirmed = await gateway.ssh.setPort(next)
      savedPort = confirmed.port
      set({
        settings: confirmed,
        portDraft: `${confirmed.port}`,
        savingPort: false,
        pendingPort: undefined,
      })
      notify(`SSH 端口已改为 ${confirmed.port}${MOCK_SUFFIX}`)
    } catch (error) {
      // 端口没改成：保留确认对话让用户能重试，原因走通知。
      set({ savingPort: false })
      notify(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'danger')
      return
    }
    // 联动放在端口保存的 try 之外：它自己的失败已在内部报成「联动失败」，
    // 不会走到上面的 catch 把已经成功的端口报成「保存失败」。
    await linkSshPortToFirewall(gateway, savedPort)
  },

  async setLoginPolicy(gateway, policy) {
    const previous = get().rootAuth
    if (!previous || get().savingPolicy) return
    set({ savingPolicy: true, rootAuth: { ...previous, policy } })
    try {
      const confirmed = await gateway.ssh.saveRootLoginPolicy(policy)
      set({ rootAuth: confirmed, savingPolicy: false })
      notify(`Root 登录已${policy === 'no' ? '禁止' : '允许'}${MOCK_SUFFIX}`)
    } catch (error) {
      set({ rootAuth: previous, savingPolicy: false })
      notify(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'danger')
    }
  },

  setPasswordDraft(value) {
    set({ passwordDraft: value })
  },

  // 空输入不发请求；判定为弱密码由服务侧拒绝（mock 与容器内 chpasswd 前的复验同一次判定），消息直接来自那一次判定。
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
      // 成功改走弹窗提醒（下一次 SSH 登录用新密码），不再叠一条通知。
      set({ rootAuth: result.auth, passwordDraft: '', resettingPassword: false, passwordResetNotice: true })
    } catch (error) {
      set({ resettingPassword: false })
      notify(error instanceof Error ? `重置失败：${error.message}` : '重置失败', 'danger')
    }
  },

  closePasswordResetNotice() {
    set({ passwordResetNotice: false })
  },

  // 生成（或重新生成）Root 密钥：私钥只进一次性弹窗，入档的 rootAuth 不带它。
  async createRootKey(gateway) {
    const hadKey = get().rootAuth?.key != null
    if (get().generatingRootKey) return
    set({ generatingRootKey: true })
    try {
      const result = await gateway.ssh.createRootKey()
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
      set({ generatingRootKey: false })
      notify(error instanceof Error ? `生成失败：${error.message}` : '生成失败', 'danger')
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
      notify(`SSH 密钥「${target.name}」已删除${MOCK_SUFFIX}`)
    } catch (error) {
      set((state) => ({
        removingKeyIds: state.removingKeyIds.filter((id) => id !== keyId),
      }))
      notify(error instanceof Error ? `删除失败：${error.message}` : '删除失败', 'danger')
    }
  },
}))
