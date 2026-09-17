import type { RuntimeLogSnapshot } from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway } from '../contracts/adapters'

type RuntimeLogStatus = 'idle' | 'loading' | 'ready' | 'error'

type RuntimeLogState = {
  status: RuntimeLogStatus
  errorMessage: string | undefined
  snapshot: RuntimeLogSnapshot | undefined
  /** 搜索按行内容过滤；只影响视图，不动数据。 */
  search: string
  /** 滑动日志：内容变化后自动滚到底部。 */
  follow: boolean
  /** 全屏展示开合。 */
  fullscreen: boolean
  /** 刷新忙碌态：刷新期间按钮置灰；首屏加载走 status。 */
  refreshing: boolean
  load: (gateway: ElysianGateway) => Promise<void>
  setSearch: (search: string) => void
  setFollow: (follow: boolean) => void
  setFullscreen: (fullscreen: boolean) => void
}

export const useRuntimeLogStore = create<RuntimeLogState>((set, get) => ({
  status: 'idle',
  errorMessage: undefined,
  snapshot: undefined,
  search: '',
  follow: true,
  fullscreen: false,
  refreshing: false,

  async load(gateway) {
    if (get().refreshing) return
    const first = get().status !== 'ready'
    set({ refreshing: true, ...(first ? { status: 'loading' as const } : {}), errorMessage: undefined })
    try {
      const snapshot = await gateway.logs.runtimeLog()
      set({ status: 'ready', snapshot, refreshing: false })
    } catch (error) {
      set({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '运行日志加载失败',
        refreshing: false,
      })
    }
  },

  setSearch(search) {
    set({ search })
  },

  setFollow(follow) {
    set({ follow })
  },

  setFullscreen(fullscreen) {
    set({ fullscreen })
  },
}))
