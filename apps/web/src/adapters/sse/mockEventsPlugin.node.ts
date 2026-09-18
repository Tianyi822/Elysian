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

async function readHostSampleFromProc(prev?: HostSamplePrev) {
  return readHostSample({
    readFile: (path) => readFile(path, 'utf8'),
    execDf: async () => {
      const { stdout } = await execFileAsync('df', ['-h', '-P'])
      return stdout
    },
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
