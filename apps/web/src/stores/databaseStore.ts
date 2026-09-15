import { create } from 'zustand'
import { DATABASE_ENGINES } from '@elysian/contracts'
import type { Container, ContainerImage, DatabaseEngine, DatabaseInstance } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'

export { DATABASE_ENGINES }
export type { DatabaseEngine }

export type DatabaseState = {
  engine: DatabaseEngine
  status: 'idle' | 'loading' | 'ready' | 'error'
  databases: readonly DatabaseInstance[]
  /** 卡片的来源容器行要从容器数据集现取名与镜像，因此与数据库一起取。 */
  containers: readonly Container[]
  images: readonly ContainerImage[]
  errorMessage?: string
  setEngine(engine: DatabaseEngine): void
  load(gateway: ElysianGateway): Promise<void>
}

/** 数据库区的界面状态：类型筛选留在内存，数据由 adapter 提供。 */
export const useDatabaseStore = create<DatabaseState>((set) => ({
  engine: 'MariaDB',
  status: 'idle',
  databases: [],
  containers: [],
  images: [],
  setEngine: (engine) => set({ engine }),
  async load(gateway) {
    set({ status: 'loading', errorMessage: undefined })
    try {
      const [databases, containers, images] = await Promise.all([
        gateway.databases.list(),
        gateway.containers.list(),
        gateway.containers.listImages(),
      ])
      set({ status: 'ready', databases, containers, images })
    } catch (error) {
      set({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '读取数据库数据失败',
      })
    }
  },
}))
