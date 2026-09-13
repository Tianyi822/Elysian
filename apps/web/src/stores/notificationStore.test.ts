import { beforeEach, describe, expect, it } from 'vitest'
import { useNotificationStore } from './notificationStore'

beforeEach(() => {
  useNotificationStore.getState().clear()
})

describe('通知 store', () => {
  it('按调用顺序追加通知，同一条不丢字段', () => {
    useNotificationStore.getState().notify({ tone: 'success', message: '第一条' })
    useNotificationStore.getState().notify({ tone: 'danger', message: '第二条' })

    expect(useNotificationStore.getState().notifications.map((item) => item.message)).toEqual([
      '第一条',
      '第二条',
    ])
    expect(useNotificationStore.getState().notifications[1]?.tone).toBe('danger')
  })

  it('每条通知的 id 唯一', () => {
    const first = useNotificationStore.getState().notify({ tone: 'info', message: 'A' })
    const second = useNotificationStore.getState().notify({ tone: 'info', message: 'B' })

    expect(first).not.toBe(second)
    expect(new Set([first, second]).size).toBe(2)
  })

  it('dismiss 只移除指定的一条', () => {
    const first = useNotificationStore.getState().notify({ tone: 'success', message: '留下的' })
    const second = useNotificationStore.getState().notify({ tone: 'success', message: '撤掉的' })

    useNotificationStore.getState().dismiss(second)

    expect(useNotificationStore.getState().notifications.map((item) => item.id)).toEqual([first])
  })

  it('clear 清空全部', () => {
    useNotificationStore.getState().notify({ tone: 'success', message: 'A' })
    useNotificationStore.getState().notify({ tone: 'danger', message: 'B' })

    useNotificationStore.getState().clear()

    expect(useNotificationStore.getState().notifications).toHaveLength(0)
  })
})
