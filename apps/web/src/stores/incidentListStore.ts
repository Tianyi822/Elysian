import type { IncidentListRow } from '@elysian/contracts'
import { create } from 'zustand'
import type { IncidentAdapter, IncidentListQuery } from '../contracts/adapters'

export type IncidentListStateStatus = 'idle' | 'loading' | 'ready' | 'error'

type IncidentListState = {
  status: IncidentListStateStatus
  rows: readonly IncidentListRow[]
  total: number
  availableSources: readonly string[]
  errorMessage?: string
  /** 适配器由调用方传入，store 因此不依赖具体数据来源。 */
  load: (adapter: IncidentAdapter, query: IncidentListQuery) => Promise<void>
}

export const useIncidentListStore = create<IncidentListState>((set) => ({
  status: 'idle',
  rows: [],
  total: 0,
  availableSources: [],
  async load(adapter, query) {
    set({ status: 'loading', errorMessage: undefined })
    try {
      const result = await adapter.listRows(query)
      set({
        status: 'ready',
        rows: result.rows,
        total: result.total,
        availableSources: result.availableSources,
      })
    } catch (error) {
      set({
        status: 'error',
        rows: [],
        total: 0,
        errorMessage: error instanceof Error ? error.message : '读取事件列表失败',
      })
    }
  },
}))
