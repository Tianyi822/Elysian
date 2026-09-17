import type { LoginLogEntry } from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway } from '../contracts/adapters'

type LoginLogStatus = 'idle' | 'loading' | 'ready' | 'error'

type LoginLogState = {
  status: LoginLogStatus
  errorMessage: string | undefined
  entries: readonly LoginLogEntry[]
  load: (gateway: ElysianGateway) => Promise<void>
}

export const useLoginLogStore = create<LoginLogState>((set, get) => ({
  status: 'idle',
  errorMessage: undefined,
  entries: [],

  async load(gateway) {
    if (get().status === 'loading') return
    set({ status: 'loading', errorMessage: undefined })
    try {
      const entries = await gateway.logs.loginLogs()
      set({ status: 'ready', entries })
    } catch (error) {
      set({ status: 'error', errorMessage: error instanceof Error ? error.message : '登录日志加载失败' })
    }
  },
}))
