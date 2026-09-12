import type { AuditRecord } from '@elysian/contracts'
import { create } from 'zustand'
import type { AuditAdapter } from '../contracts/adapters'

type AuditLogState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  records: readonly AuditRecord[]
  errorMessage?: string
  load: (adapter: AuditAdapter) => Promise<void>
}

export const useAuditLogStore = create<AuditLogState>((set) => ({
  status: 'idle',
  records: [],
  async load(adapter) {
    set({ status: 'loading', errorMessage: undefined })
    try {
      const records = await adapter.list()
      set({ status: 'ready', records })
    } catch (error) {
      set({
        status: 'error',
        records: [],
        errorMessage: error instanceof Error ? error.message : '读取审计记录失败',
      })
    }
  },
}))
