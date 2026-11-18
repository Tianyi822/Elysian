import type { LogListQuery, LogStorageStats, PlatformLogCategory, RuntimeLogEntry } from '@elysian/contracts'
import { PLATFORM_LOG_CATEGORY_LABELS, formatLogBytes } from '@elysian/contracts'
import { create } from 'zustand'
import { isDockerRuntime } from '../utils/isDockerRuntime'
import { demoNoticeSuffix, DEMO_LOG_CLEAR_NOTE } from '../utils/demoNotice'
import type { ElysianGateway } from '../contracts/adapters'
import { createLogReader } from './logReader'
import { useMessageStore } from './messageStore'
import { messageOf } from '../utils/errorMessage'

type RuntimeLogStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 清空完成提示的演示标注：容器内清的是服务器上的真实文件，不再带标注。 */
const MOCK_SUFFIX = demoNoticeSuffix(isDockerRuntime(), DEMO_LOG_CLEAR_NOTE)

function currentQuery(search: string): LogListQuery {
  const query: LogListQuery = {}
  const q = search.trim()
  if (q) query.q = q
  return query
}

type RuntimeLogState = {
  status: RuntimeLogStatus
  errorMessage: string | undefined
  /** 时间倒序（新 → 旧），与操作日志一致；界面按此顺序渲染，纵向滚动位置交给用户。 */
  entries: readonly RuntimeLogEntry[]
  total: number
  /** 因条数上限或读取字节预算未读全（更旧的内容还在服务器磁盘上）。 */
  truncated: boolean
  /** 无法解析而被跳过的行数与读取失败而被整份跳过的文件数（正常为 0）。 */
  skippedLines: number
  skippedFiles: number
  storage: LogStorageStats | undefined
  /** 搜索匹配 message 与 source，大小写不敏感；只改状态，由面板触发 load。 */
  search: string
  /** 刷新忙碌态：刷新期间按钮置灰；首屏加载走 status。 */
  refreshing: boolean
  manualRefreshing: boolean
  loadingOlder: boolean
  olderError: string | undefined
  /** 清空忙碌态：二次确认之后的删除请求进行中。 */
  clearing: boolean
  /** 待清空的类别（清空二次确认的目标）；null 表示弹窗关闭。 */
  clearTarget: PlatformLogCategory | null
  load: (gateway: ElysianGateway, options?: { silent?: boolean }) => Promise<void>
  loadOlder: (gateway: ElysianGateway) => Promise<void>
  setSearch: (search: string) => void
  openClear: (category: PlatformLogCategory) => void
  closeClear: () => void
  clear: (gateway: ElysianGateway) => Promise<void>
  resetSession: () => void
}

export const useRuntimeLogStore = create<RuntimeLogState>((set, get) => {
  let activeClear: symbol | undefined
  const reader = createLogReader<RuntimeLogEntry, LogListQuery, RuntimeLogState>({
    get, set,
    queryFor: state => currentQuery(state.search),
    read: (gateway, query) => gateway.logs.runtimeLog(query),
    timeOf: entry => entry.at,
    blocked: state => state.clearing,
    trackStorage: true,
    trackManualRefresh: true,
  })
  const initialDisplay = {
    status: 'idle',
    errorMessage: undefined,
    entries: [],
    total: 0,
    truncated: false,
    skippedLines: 0,
    skippedFiles: 0,
    storage: undefined,
    search: '',
    refreshing: false,
    manualRefreshing: false,
    loadingOlder: false,
    olderError: undefined,
    clearing: false,
    clearTarget: null,
  } satisfies Partial<RuntimeLogState>

  return {
    ...initialDisplay,
    load: reader.load,
    loadOlder: reader.loadOlder,

    resetSession() {
      activeClear = undefined
      reader.invalidateReads({ dropSnapshot: true })
      set(initialDisplay)
    },

    setSearch(search) {
      const changed = search.trim() !== get().search.trim()
      set({ search, ...(changed ? reader.invalidateReads() : {}) })
    },

    openClear(category) {
      set({ clearTarget: category })
    },

    closeClear() {
      set({ clearTarget: null })
    },

    async clear(gateway) {
      const category = get().clearTarget
      if (!category || get().clearing) return
      const operation = Symbol()
      activeClear = operation
      set({ ...reader.invalidateReads({ dropSnapshot: true }), clearing: true })
      try {
        const report = await gateway.logs.clearLogs(category)
        if (activeClear !== operation) return
        useMessageStore.getState().notify({
          tone: 'success',
          message: `${PLATFORM_LOG_CATEGORY_LABELS[report.category]}已清空：删除 ${report.rowCount} 条记录，释放 ${formatLogBytes(report.totalBytes)}${MOCK_SUFFIX}`,
        })
        activeClear = undefined
        set({ clearTarget: null, clearing: false })
        // 清空后重新读取：正常会读到一条「已清空」留痕（自指留痕），不是空表。
        await get().load(gateway, { silent: true })
      } catch (error) {
        if (activeClear !== operation) return
        activeClear = undefined
        // 失败保留弹窗（用户可重试）：只解除忙碌态，不动 clearTarget。
        useMessageStore.getState().notify({
          tone: 'danger',
          message: `清空失败：${messageOf(error)}`,
        })
        set({ clearing: false })
      }
    },
  }
})
