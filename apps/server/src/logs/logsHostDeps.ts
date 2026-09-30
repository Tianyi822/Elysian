import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ELYSIAN_PATHS } from '../shared/elysianPaths.ts'
import type { LogStore } from './logStoreTypes.ts'
import { createLogsService, type LogsService } from './logsService.ts'
import { createUnavailableLogStore } from './unavailableLogStore.ts'

export type LogsHostDepsOptions = {
  /** 平台日志分片根目录；缺省为 ELYSIAN_PATHS.platformLogsDir。 */
  platformLogsDir?: string
  /** SQLite 库路径；缺省为 ELYSIAN_PATHS.logsSqlite。 */
  logsSqlitePath?: string
  /** 时钟注入：缺省真实时钟（测试用假时钟）。 */
  now?: () => Date
}

export type LogsHostDeps = {
  service: LogsService
}

function startTimer(onTick: () => void, intervalMs: number): void {
  const timer = setInterval(onTick, intervalMs)
  timer.unref()
}

/**
 * 打开 SQLite、导入既有分片，产出 `{ service }`；库不可用时回落不可用 store。
 * openLogStore / importPlatformLogs 动态加载，避免 vitest 静态图牵出 bun:sqlite（D14）。
 */
export async function createLogsHostDeps(options: LogsHostDepsOptions = {}): Promise<LogsHostDeps> {
  const platformLogsDir = options.platformLogsDir ?? ELYSIAN_PATHS.platformLogsDir
  const logsSqlitePath = options.logsSqlitePath ?? ELYSIAN_PATHS.logsSqlite
  let store: LogStore
  try {
    await mkdir(dirname(logsSqlitePath), { recursive: true, mode: 0o700 })
    const { openLogStore } = await import('./logStore.ts')
    const { importPlatformLogs } = await import('./logImport.ts')
    store = openLogStore(logsSqlitePath)
    await importPlatformLogs(store, platformLogsDir)
  } catch (error) {
    console.error(`Elysian 日志数据库不可用：${error instanceof Error ? error.message : String(error)}`)
    store = createUnavailableLogStore()
  }
  return {
    service: createLogsService({
      store,
      now: options.now ?? (() => new Date()),
      startTimer,
    }),
  }
}
