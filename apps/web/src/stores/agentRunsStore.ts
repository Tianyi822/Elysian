import type { AgentRun, ModuleStatus } from '@elysian/contracts'
import { create } from 'zustand'
import type { RunAdapter } from '../contracts/adapters'

type AgentRunsState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  runs: readonly AgentRun[]
  moduleStatuses: readonly ModuleStatus[]
  errorMessage?: string
  load: (adapter: RunAdapter) => Promise<void>
}

export const useAgentRunsStore = create<AgentRunsState>((set) => ({
  status: 'idle',
  runs: [],
  moduleStatuses: [],
  async load(adapter) {
    set({ status: 'loading', errorMessage: undefined })
    try {
      const [runs, moduleStatuses] = await Promise.all([
        adapter.list(),
        adapter.listModuleStatuses(),
      ])
      set({ status: 'ready', runs, moduleStatuses })
    } catch (error) {
      set({
        status: 'error',
        runs: [],
        moduleStatuses: [],
        errorMessage: error instanceof Error ? error.message : '读取 Agent 运行失败',
      })
    }
  },
}))
