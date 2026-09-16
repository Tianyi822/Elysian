import type { HostUser, HostUserInput } from '@elysian/contracts'
import { HOST_USER_LOGIN_METHOD_LABELS, HOST_USER_STATUS_LABELS } from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from './notificationStore'

/** 用户管理页签的状态：主机账号列表与两个弹窗。 */
type UsersStatus = 'idle' | 'loading' | 'ready' | 'error'

type UsersState = {
  status: UsersStatus
  errorMessage: string | undefined
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
  load: (gateway: ElysianGateway) => Promise<void>
  setSearch: (search: string) => void
  syncFromSystem: (gateway: ElysianGateway) => Promise<void>
  openCreate: () => void
  openEdit: (user: HostUser) => void
  closeDialog: () => void
  saveUser: (gateway: ElysianGateway, input: HostUserInput & { name?: string }) => Promise<boolean>
  openRemove: (user: HostUser) => void
  closeRemove: () => void
  removeUser: (gateway: ElysianGateway, userId: string) => Promise<void>
}

function notify(message: string, tone: 'success' | 'danger' = 'success'): void {
  useNotificationStore.getState().notify({ message, tone })
}

export const useUsersStore = create<UsersState>((set, get) => ({
  status: 'idle',
  errorMessage: undefined,
  users: [],
  search: '',
  syncing: false,
  dialogUser: undefined,
  removeTarget: undefined,
  saving: false,
  removingUserIds: [],

  async load(gateway) {
    if (get().status === 'loading') return
    set({ status: 'loading', errorMessage: undefined })
    try {
      const users = await gateway.users.list()
      set({ status: 'ready', users })
    } catch (error) {
      set({ status: 'error', errorMessage: error instanceof Error ? error.message : '账号数据加载失败' })
    }
  },

  setSearch(search) {
    set({ search })
  },

  // 同步后重新读一遍列表：真实实现里系统可能新增或删除了账号，只更新数字是不够的。
  async syncFromSystem(gateway) {
    if (get().syncing) return
    set({ syncing: true })
    try {
      const { total } = await gateway.users.syncFromSystem()
      const users = await gateway.users.list()
      set({ users, syncing: false })
      notify(`已从系统同步账号，当前共 ${total} 个（mock，待接入真实执行）`)
    } catch (error) {
      set({ syncing: false })
      notify(error instanceof Error ? `同步失败：${error.message}` : '同步失败', 'danger')
    }
  },

  openCreate() {
    set({ dialogUser: 'new' })
  },

  openEdit(user) {
    set({ dialogUser: user })
  },

  closeDialog() {
    set({ dialogUser: undefined, saving: false })
  },

  // 保存成功返回 true，弹窗据此关闭；失败保留弹窗与已填内容。
  async saveUser(gateway, input) {
    const editing = get().dialogUser
    if (editing === undefined || get().saving) return false
    set({ saving: true })
    try {
      if (editing === 'new') {
        if (!input.name) {
          set({ saving: false })
          return false
        }
        const created = await gateway.users.create({ ...input, name: input.name })
        set((state) => ({ users: [created, ...state.users], dialogUser: undefined, saving: false }))
        notify(`账号 ${created.name} 已创建（mock，待接入真实执行）`)
      } else {
        const updated = await gateway.users.update(editing.id, {
          loginMethod: input.loginMethod,
          status: input.status,
          isAdmin: input.isAdmin,
          note: input.note,
        })
        set((state) => ({
          users: state.users.map((user) => (user.id === updated.id ? updated : user)),
          dialogUser: undefined,
          saving: false,
        }))
        notify(
          `账号 ${updated.name} 已改为「${HOST_USER_LOGIN_METHOD_LABELS[updated.loginMethod]}」· ${HOST_USER_STATUS_LABELS[updated.status]}（mock，待接入真实执行）`,
        )
      }
      return true
    } catch (error) {
      set({ saving: false })
      notify(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'danger')
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
    const target = get().users.find((user) => user.id === userId)
    if (!target || get().removingUserIds.includes(userId)) return
    set((state) => ({ removingUserIds: [...state.removingUserIds, userId] }))
    try {
      await gateway.users.remove(userId)
      set((state) => ({
        users: state.users.filter((user) => user.id !== userId),
        removingUserIds: state.removingUserIds.filter((id) => id !== userId),
      }))
      notify(`账号 ${target.name} 已删除（mock，待接入真实执行）`)
    } catch (error) {
      set((state) => ({
        removingUserIds: state.removingUserIds.filter((id) => id !== userId),
      }))
      notify(error instanceof Error ? `删除失败：${error.message}` : '删除失败', 'danger')
    }
  },
}))
