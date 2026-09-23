import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../adapters/mock/gateway'
import { SEED_RUNTIME_LOGS, resetLogsData } from '../adapters/mock/logsData'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from './notificationStore'
import { useRuntimeLogStore } from './runtimeLogStore'

/*
 * 运行日志 store 的行为测试：读取落状态、刷新单飞、跟随开关、清空的成功与失败两条路。
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
      runtimeLog: overrides.runtimeLog ?? (() => base.logs.runtimeLog()),
      loginLogs: overrides.loginLogs ?? (() => base.logs.loginLogs()),
      operationLogs: overrides.operationLogs ?? (() => base.logs.operationLogs()),
      clearLogs: overrides.clearLogs ?? ((category) => base.logs.clearLogs(category)),
    },
  }
}

beforeEach(() => {
  resetLogsData()
  useRuntimeLogStore.setState(useRuntimeLogStore.getInitialState())
  useNotificationStore.setState({ notifications: [] })
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

  it('刷新期间单飞：第一笔未落定时再刷新直接忽略', async () => {
    const first = deferred<Awaited<ReturnType<ElysianGateway['logs']['runtimeLog']>>>()
    const runtimeLog = vi.fn(() => first.promise)
    const gateway = gatewayWith({ runtimeLog })

    const inFlight = useRuntimeLogStore.getState().load(gateway)
    expect(useRuntimeLogStore.getState().refreshing).toBe(true)
    await useRuntimeLogStore.getState().load(gateway)
    expect(runtimeLog).toHaveBeenCalledTimes(1)

    first.resolve(await gatewayWith().logs.runtimeLog())
    await inFlight
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

    const notice = useNotificationStore.getState().notifications[0]
    expect(notice?.tone).toBe('success')
    expect(notice?.message).toContain('运行日志已清空')
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
    const notice = useNotificationStore.getState().notifications[0]
    expect(notice?.tone).toBe('danger')
    expect(notice?.message).toContain('清空端点不可用')
  })
})
