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
        set((state) => ({
          recent: [event, ...state.recent].slice(0, MAX_RECENT_EVENTS),
          receivedCount: state.receivedCount + 1,
        }))
      },
    })
  },
  disconnect() {
    unsubscribe?.()
    unsubscribe = undefined
    generation += 1
  },
}))
