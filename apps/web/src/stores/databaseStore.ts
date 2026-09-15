import { create } from 'zustand'
import { DATABASE_ENGINES } from '@elysian/contracts'
import type { DatabaseEngine, DatabaseInstance } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'

export { DATABASE_ENGINES }
export type { DatabaseEngine }

export type DatabaseState = {
  engine: DatabaseEngine
  status: 'idle' | 'loading' | 'ready' | 'error'
  databases: readonly DatabaseInstance[]
  errorMessage?: string
  setEngine(engine: DatabaseEngine): void
  load(gateway: ElysianGateway): Promise<void>
}

/** 数据库区的界面状态：类型筛选留在内存，数据由 adapter 提供。 */
export const useDatabaseStore = create<DatabaseState>((set) => ({
  engine: 'MariaDB',
  status: 'idle',
  databases: [],
  setEngine: (engine) => set({ engine }),
  async load(gateway) {
    set({ status: 'loading', errorMessage: undefined })
    try {
      const databases = await gateway.databases.list()
      set({ status: 'ready', databases })
    } catch (error) {
      set({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '读取数据库数据失败',
      })
    }
  },
}))
