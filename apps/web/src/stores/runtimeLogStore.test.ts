import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogListQuery } from '@elysian/contracts'
import { createMockGateway } from '../adapters/mock/gateway'
import { SEED_RUNTIME_LOGS, resetLogsData } from '../adapters/mock/logsData'
import type { ElysianGateway } from '../contracts/adapters'
import { useMessageStore } from './messageStore'
import { useRuntimeLogStore } from './runtimeLogStore'

/*
 * 运行日志 store 的行为测试：读取落状态、并发请求以最新为准、清空的成功与失败两条路。
 * 网关用 mock 数据集（内存数组，清空与 reset 都是演示语义），事件流固定 'memory'。
 */

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** 逐方法转发而不是展开 `base.logs`：mock adapter 是类实例，展开会丢掉原型上的方法。 */
function gatewayWith(overrides: Partial<ElysianGateway['logs']> = {}): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  return {
    ...base,
    logs: {
      runtimeLog: overrides.runtimeLog ?? ((query) => base.logs.runtimeLog(query)),
      loginLogs: overrides.loginLogs ?? ((query) => base.logs.loginLogs(query)),
      operationLogs: overrides.operationLogs ?? ((query) => base.logs.operationLogs(query)),
      clearLogs: overrides.clearLogs ?? ((category) => base.logs.clearLogs(category)),
    },
  }
}

beforeEach(() => {
  resetLogsData()
  useRuntimeLogStore.setState(useRuntimeLogStore.getInitialState())
  useMessageStore.setState({ messages: [] })
})

describe('运行日志 store', () => {
  it('load 成功后落条目、截断计数与存储统计', async () => {
    await useRuntimeLogStore.getState().load(gatewayWith())

    const state = useRuntimeLogStore.getState()
    expect(state.status).toBe('ready')
    expect(state.entries).toEqual(SEED_RUNTIME_LOGS)
    expect(state.truncated).toBe(false)
    expect(state.skippedLines).toBe(0)
    expect(state.storage?.runtimeBytes).toBeGreaterThan(0)
    expect(state.refreshing).toBe(false)
  })

  it('并发 load 以最新请求为准：旧响应丢弃', async () => {
    const first = deferred<Awaited<ReturnType<ElysianGateway['logs']['runtimeLog']>>>()
    const second = deferred<Awaited<ReturnType<ElysianGateway['logs']['runtimeLog']>>>()
    let calls = 0
    const runtimeLog = vi.fn(() => {
      calls += 1
      return calls === 1 ? first.promise : second.promise
    })
    const gateway = gatewayWith({ runtimeLog })
    const report = await gatewayWith().logs.runtimeLog()

    const older = useRuntimeLogStore.getState().load(gateway)
    const newer = useRuntimeLogStore.getState().load(gateway)
    expect(runtimeLog).toHaveBeenCalledTimes(2)

    first.resolve({ ...report, total: 1, entries: report.entries.slice(0, 1) })
    await older
    expect(useRuntimeLogStore.getState().total).not.toBe(1)

    second.resolve({ ...report, total: 9 })
    await newer
    expect(useRuntimeLogStore.getState().total).toBe(9)
    expect(useRuntimeLogStore.getState().refreshing).toBe(false)
  })

  it('load 失败进入错误态并保留中文消息', async () => {
    await useRuntimeLogStore
      .getState()
      .load(gatewayWith({ runtimeLog: async () => { throw new Error('运行日志端点不可用') } }))

    const state = useRuntimeLogStore.getState()
    expect(state.status).toBe('error')
    expect(state.errorMessage).toBe('运行日志端点不可用')
  })

  it('load 按搜索传 q 并写入 total', async () => {
    const calls: LogListQuery[] = []
    const gateway = gatewayWith({
      runtimeLog: async (query) => {
        calls.push(query ?? {})
        return {
          entries: SEED_RUNTIME_LOGS.slice(0, 1),
          total: 9,
          truncated: true,
          skippedLines: 0,
          skippedFiles: 0,
          storage: (await gatewayWith().logs.runtimeLog()).storage,
        }
      },
    })
    useRuntimeLogStore.getState().setSearch(' 慢查询 ')
    await useRuntimeLogStore.getState().load(gateway)
    expect(calls.at(-1)).toEqual({ q: '慢查询' })
    expect(useRuntimeLogStore.getState().total).toBe(9)
  })

  it('清空成功后通知并重新读取：列表只剩一条留痕，弹窗关闭', async () => {
    const gateway = gatewayWith()
    await useRuntimeLogStore.getState().load(gateway)
    useRuntimeLogStore.getState().openClear('runtime')
    expect(useRuntimeLogStore.getState().clearTarget).toBe('runtime')

    await useRuntimeLogStore.getState().clear(gateway)

    const state = useRuntimeLogStore.getState()
    expect(state.clearTarget).toBeNull()
    expect(state.clearing).toBe(false)
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]!.source).toBe('logs.clear')

    const notice = useMessageStore.getState().messages[0]
    expect(notice?.tone).toBe('success')
    expect(notice?.message).toContain('运行日志已清空')
    expect(notice?.message).toContain('条记录')
  })

  it('清空失败：通知失败并保留弹窗供重试', async () => {
    const gateway = gatewayWith({
      clearLogs: async () => {
        throw new Error('清空端点不可用')
      },
    })
    useRuntimeLogStore.getState().openClear('runtime')

    await useRuntimeLogStore.getState().clear(gateway)

    expect(useRuntimeLogStore.getState().clearTarget).toBe('runtime')
    expect(useRuntimeLogStore.getState().clearing).toBe(false)
    const notice = useMessageStore.getState().messages[0]
    expect(notice?.tone).toBe('danger')
    expect(notice?.message).toContain('清空端点不可用')
  })
})
