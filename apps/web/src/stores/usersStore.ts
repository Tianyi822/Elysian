import { securityActionFailure, securitySessionChanged, type SecurityActionResult } from './securityActionResult'
import { captureAuthGeneration } from '../utils/authGeneration'
import { hasUncertainOutcome } from '../adapters/http/requestDeadline'
import type { HostUser, HostUserInput } from '@elysian/contracts'
import { HOST_USER_LOGIN_METHOD_LABELS, HOST_USER_STATUS_LABELS } from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway } from '../contracts/adapters'
import { isDockerRuntime } from '../utils/isDockerRuntime'
import { demoNoticeSuffix, MOCK_ACTION_NOTE } from '../utils/demoNotice'
import { useMessageStore } from './messageStore'
import { messageOf } from '../utils/errorMessage'

/** 用户管理页签的状态：主机账号列表与两个弹窗。 */
type UsersStatus = 'idle' | 'loading' | 'ready' | 'error'

type UsersState = {
  status: UsersStatus
  errorMessage: string | undefined
  operationError: string | undefined
  users: readonly HostUser[]
  /** 搜索词：按用户名与备注匹配。 */
  search: string
  /** 从系统同步账号的忙碌态。 */
  syncing: boolean
  /** 弹窗正在编辑的账号：'new' 表示新建，非空表示在改这一个。 */
  dialogUser: HostUser | 'new' | undefined
  removeTarget: HostUser | undefined
  saving: boolean
  removingUserIds: readonly string[]
  /** 返回本次读取是否成功并仍属当前会话。 */
  load: (gateway: ElysianGateway) => Promise<boolean>
  clearDisplay(): void
  setSearch: (search: string) => void
  syncFromSystem: (gateway: ElysianGateway) => Promise<void>
  openCreate: () => void
  openEdit: (user: HostUser) => void
  closeDialog: () => void
  saveUser: (gateway: ElysianGateway, input: HostUserInput & { name?: string }) => Promise<boolean>
  openRemove: (user: HostUser) => void
  closeRemove: () => void
  removeUser: (gateway: ElysianGateway, userId: string) => Promise<SecurityActionResult>
}

function notify(message: string, tone: 'success' | 'danger' = 'success'): void {
  useMessageStore.getState().notify({ message, tone })
}

/**
 * 动作完成提示的演示标注：Docker 运行时动作已真实执行 useradd/usermod/userdel/gpasswd/chpasswd，
 * 不再带标注；宿主机本地开发（内存演示）保留。括号形态追加在句子末尾，只用这一个来源。
 */
const MOCK_SUFFIX = demoNoticeSuffix(isDockerRuntime(), MOCK_ACTION_NOTE)

export const useUsersStore = create<UsersState>((set, get) => {
  let deletionAuth = captureAuthGeneration()
  const syncDeletionGeneration = () => {
    const auth = captureAuthGeneration()
    if (auth !== deletionAuth) { deletionAuth = auth; set({ removingUserIds: [] }) }
    return auth
  }
  let pendingLoad: { gateway: ElysianGateway; auth: number; snapshot: readonly HostUser[]; promise: Promise<boolean> } | undefined
  const recordFailure = async (error: unknown, gateway: ElysianGateway) => {
    const auth = captureAuthGeneration()
    const message = messageOf(error, '操作失败，请重试')
    if (hasUncertainOutcome(error)) await get().load(gateway)
    if (auth === captureAuthGeneration()) set({ operationError: message })
  }
  return ({
  status: 'idle',
  errorMessage: undefined,
  operationError: undefined,
  users: [],
  search: '',
  syncing: false,
  dialogUser: undefined,
  removeTarget: undefined,
  saving: false,
  removingUserIds: [],

  clearDisplay() {
    pendingLoad = undefined
    set({
      status: 'idle', users: [], errorMessage: undefined, operationError: undefined,
      syncing: false, saving: false, dialogUser: undefined, removeTarget: undefined, removingUserIds: [],
    })
  },

  load(gateway) {
    const auth = syncDeletionGeneration()
    if (pendingLoad?.gateway === gateway && pendingLoad.auth === auth && pendingLoad.snapshot === get().users) return pendingLoad.promise
    const hadData = get().status === 'ready'
    const operation = { gateway, auth, snapshot: get().users, promise: Promise.resolve(false) }
    pendingLoad = operation
    const current = () => pendingLoad === operation && auth === captureAuthGeneration()
    set({ status: hadData ? 'ready' : 'loading', errorMessage: undefined })
    operation.promise = (async () => {
      try {
        const users = await gateway.users.list()
        if (!current()) return false
        if (operation.snapshot === get().users) set({ status: 'ready', users, operationError: undefined, errorMessage: undefined })
        return true
      } catch (error) {
        if (current()) set({ status: hadData ? 'ready' : 'error', errorMessage: messageOf(error, '账号数据加载失败') })
        return false
      } finally { if (pendingLoad === operation) pendingLoad = undefined }
    })()
    return operation.promise
  },

  setSearch(search) {
    set({ search })
  },

  // 同步后重新读一遍列表：真实实现里系统可能新增或删除了账号，只更新数字是不够的。
  async syncFromSystem(gateway) {
    if (get().syncing) return
    const auth = captureAuthGeneration()
    set({ syncing: true })
    try {
      const { total } = await gateway.users.syncFromSystem()
      if (auth !== captureAuthGeneration()) return
      const users = await gateway.users.list()
      if (auth !== captureAuthGeneration()) return
      set({ users, syncing: false })
      notify(`已从系统同步账号，当前共 ${total} 个${MOCK_SUFFIX}`)
    } catch (error) {
      if (auth !== captureAuthGeneration()) return
      set({ syncing: false })
      notify(error instanceof Error ? `同步失败：${error.message}` : '同步失败', 'danger')
      await recordFailure(error, gateway)
    }
  },

  openCreate() {
    set({ dialogUser: 'new', operationError: undefined })
  },

  openEdit(user) {
    set({ dialogUser: user, operationError: undefined })
  },

  closeDialog() {
    set({ dialogUser: undefined, saving: false })
  },

  // 保存成功返回 true，弹窗据此关闭；失败保留弹窗与已填内容。
  async saveUser(gateway, input) {
    const editing = get().dialogUser
    if (editing === undefined || get().saving) return false
    const auth = captureAuthGeneration()
    set({ saving: true, operationError: undefined })
    try {
      if (editing === 'new') {
        if (!input.name) {
          set({ saving: false })
          return false
        }
        const created = await gateway.users.create({ ...input, name: input.name })
        if (auth !== captureAuthGeneration()) return false
        set((state) => ({ users: [created, ...state.users], dialogUser: undefined, saving: false }))
        notify(`账号 ${created.name} 已创建${MOCK_SUFFIX}`)
      } else {
        const updated = await gateway.users.update(editing.id, {
          loginMethod: input.loginMethod,
          status: input.status,
          isAdmin: input.isAdmin,
          note: input.note,
          // 密码透传：弹窗只在填了新密码时带该字段，留空（undefined）即本次不动密码。
          ...(input.password !== undefined ? { password: input.password } : {}),
        })
        if (auth !== captureAuthGeneration()) return false
        set((state) => ({
          users: state.users.map((user) => (user.id === updated.id ? updated : user)),
          dialogUser: undefined,
          saving: false,
        }))
        notify(
          `账号 ${updated.name} 已改为「${HOST_USER_LOGIN_METHOD_LABELS[updated.loginMethod]}」· ${HOST_USER_STATUS_LABELS[updated.status]}${MOCK_SUFFIX}`,
        )
      }
      return true
    } catch (error) {
      if (auth !== captureAuthGeneration()) return false
      set({ saving: false })
      notify(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'danger')
      await recordFailure(error, gateway)
      return false
    }
  },

  openRemove(user) {
    set({ removeTarget: user })
  },

  closeRemove() {
    set({ removeTarget: undefined })
  },

  async removeUser(gateway, userId) {
    const auth = syncDeletionGeneration()
    const target = get().users.find((user) => user.id === userId)
    if (!target || get().removingUserIds.includes(userId)) return { status: 'failed', error: '账号不存在或正在删除，请重新读取状态' }
    set((state) => ({ removingUserIds: [...state.removingUserIds, userId] }))
    try {
      await gateway.users.remove(userId)
      if (auth !== captureAuthGeneration()) return securitySessionChanged()
      set((state) => ({
        users: state.users.filter((user) => user.id !== userId),
        removingUserIds: state.removingUserIds.filter((id) => id !== userId),
      }))
      notify(`账号 ${target.name} 已删除${MOCK_SUFFIX}`)
      return { status: 'succeeded' }
    } catch (error) {
      if (auth !== captureAuthGeneration()) return securitySessionChanged()
      set((state) => ({
        removingUserIds: state.removingUserIds.filter((id) => id !== userId),
      }))
      notify(error instanceof Error ? `删除失败：${error.message}` : '删除失败', 'danger')
      await recordFailure(error, gateway)
      return securityActionFailure(error, '删除失败')
    }
  },
})
})
