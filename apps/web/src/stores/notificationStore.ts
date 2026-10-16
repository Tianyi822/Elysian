import { create } from 'zustand'

export type NotificationTone = 'success' | 'info' | 'warning' | 'danger'

export type AppNotification = {
  id: string
  tone: NotificationTone
  message: string
}

export type NotificationState = {
  notifications: readonly AppNotification[]
  notify: (input: { tone: NotificationTone; message: string }) => string
  update: (id: string, input: { tone: NotificationTone; message: string }) => void
  dismiss: (id: string) => void
  clear: () => void
}

let nextId = 0

/**
 * 全局操作反馈。界面上的「刚才那一下有没有生效」统一走这里，
 * 由 NotificationHost 渲染在页面右上角，不在各页面里另写反馈条。
 * 状态只在内存里，刷新即清空。
 */
export const useNotificationStore = create<NotificationState>((set) => ({
  notifications: [],
  notify({ tone, message }) {
    nextId += 1
    const id = `notice-${nextId}`
    set((state) => ({ notifications: [...state.notifications, { id, tone, message }] }))
    return id
  },
  update(id, input) {
    set((state) => ({
      notifications: state.notifications.map((notification) => notification.id === id ? { ...notification, ...input } : notification),
    }))
  },
  dismiss(id) {
    set((state) => ({
      notifications: state.notifications.filter((notification) => notification.id !== id),
    }))
  },
  clear() {
    set({ notifications: [] })
  },
}))
