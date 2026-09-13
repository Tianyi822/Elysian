import type { ElysianEvent, EventStreamStatus, Unsubscribe } from '@elysian/contracts'
import { create } from 'zustand'
import type { EventsAdapter } from '../contracts/adapters'

/** 只保留最近的事件，避免长时间运行时内存无限增长。 */
export const MAX_RECENT_EVENTS = 200

type EventStreamState = {
  status: EventStreamStatus
  recent: readonly ElysianEvent[]
  receivedCount: number
  connect: (adapter: EventsAdapter) => void
  disconnect: () => void
}

/** 退订函数放在模块作用域，不进 store 状态，避免把函数当数据到处传。 */
let unsubscribe: Unsubscribe | undefined

/**
 * 订阅代次。退订或重新订阅都会让它前进，旧订阅的回调随即失效——
 * 适配器即使没干净地停止回调，也不会再写进界面状态。
 */
let generation = 0

/**
 * 应用级事件监听器。事件流全应用只订阅一次（见 AppShell），
 * 其他模块（例如仪表盘 store）通过这里拿到事件，不各自开连接。
 */
const listeners = new Set<(event: ElysianEvent) => void>()

export function onStreamEvent(listener: (event: ElysianEvent) => void): Unsubscribe {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useEventStreamStore = create<EventStreamState>((set) => ({
  status: 'connecting',
  recent: [],
  receivedCount: 0,
  connect(adapter) {
    unsubscribe?.()
    generation += 1
    const current = generation

    unsubscribe = adapter.subscribe({
      onStatus: (status) => {
        if (current !== generation) return
        set({ status })
      },
      onEvent: (event) => {
        if (current !== generation) return
        // 资源采样是图表的数据心跳（每拍一条），不是可读的活动记录，
        // 进最近活动只会把列表刷成噪音；监听器（仪表盘）仍然照常收到。
        if (event.name === 'resource/sample') {
          for (const listener of listeners) listener(event)
          return
        }
        // 按事件标识去重：重新订阅会让事件源从头开始计数。去重之后的响铃才发给监听器，
        // 否则重放的旧事件会推高下游计数。
        const duplicate = useEventStreamStore
          .getState()
          .recent.some((seen) => seen.id === event.id)
        if (duplicate) return
        set((state) => ({
          recent: [event, ...state.recent].slice(0, MAX_RECENT_EVENTS),
          receivedCount: state.receivedCount + 1,
        }))
        for (const listener of listeners) listener(event)
      },
    })
  },
  disconnect() {
    unsubscribe?.()
    unsubscribe = undefined
    generation += 1
  },
}))
