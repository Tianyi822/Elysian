import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { Plugin } from 'vite'
import { isDockerEnv } from '../hostMetrics/isDockerEnv.ts'
import {
  METRICS_SQLITE_PATH,
  openMetricsStore,
  type MetricsStore,
} from '../hostMetrics/metricsStore.ts'
import { readHostSample, type HostSamplePrev } from '../hostMetrics/readHostSample.ts'
import { createEventsHandler, createResourceHistoryHandler } from './mockEventsPlugin.ts'

const execFileAsync = promisify(execFile)

/**
 * df 采样参数：-k 输出纯数字的 KiB 容量列、-P 固定 POSIX 单行格式，与 readHostSample
 * 里 parseDf 按纯数字列解析的约定一致（-h 的人类可读列如 59G 会被截成 59，差约 6 个数量级）。
 */
export const DF_ARGS = ['-k', '-P'] as const

async function execDfReal(): Promise<string> {
  const { stdout } = await execFileAsync('df', [...DF_ARGS])
  return stdout
}

/** /proc 与 df 的采样入口；df 与 /proc 读取均可注入，测试用固定文本还原真实格式。 */
export async function readHostSampleFromProc(
  prev?: HostSamplePrev,
  execDf: () => Promise<string> = execDfReal,
  readFileFn: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
) {
  return readHostSample({
    readFile: readFileFn,
    execDf,
    prev,
  })
}

function ensureMetricsDir(): void {
  mkdirSync(dirname(METRICS_SQLITE_PATH), { recursive: true })
}

let sharedMetricsStore: MetricsStore | undefined

function getSharedMetricsStore(): MetricsStore {
  if (!sharedMetricsStore) {
    ensureMetricsDir()
    sharedMetricsStore = openMetricsStore(METRICS_SQLITE_PATH)
  }
  return sharedMetricsStore
}

/** 仅由 Vite 配置加载：含 bun:sqlite 与本机 /proc 采样。 */
export function createElysianDevMiddlewares(): {
  eventsHandler: ReturnType<typeof createEventsHandler>
  historyHandler: ReturnType<typeof createResourceHistoryHandler>
} {
  const docker = isDockerEnv()
  const metricsStore = docker ? getSharedMetricsStore() : undefined
  return {
    eventsHandler: createEventsHandler({
      docker,
      store: metricsStore,
      readSample: docker ? readHostSampleFromProc : undefined,
    }),
    historyHandler: createResourceHistoryHandler({ docker, store: metricsStore }),
  }
}

export function mockEventsPlugin(): Plugin {
  const { eventsHandler, historyHandler } = createElysianDevMiddlewares()

  return {
    name: 'elysian-mock-events',
    configureServer(server) {
      server.middlewares.use('/api/events', eventsHandler)
      server.middlewares.use('/api/resources/history', historyHandler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/events', eventsHandler)
      server.middlewares.use('/api/resources/history', historyHandler)
    },
  }
}
