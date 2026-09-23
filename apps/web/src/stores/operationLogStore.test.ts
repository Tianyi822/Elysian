import { beforeEach, describe, expect, it } from 'vitest'
import { createMockGateway } from '../adapters/mock/gateway'
import { SEED_OPERATION_LOGS, resetLogsData } from '../adapters/mock/logsData'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from './notificationStore'
import { useOperationLogStore } from './operationLogStore'

/*
 * 操作日志 store 的行为测试：读取落状态（倒序条目）、两个筛选维度、按类别清空。
 * 与运行日志同构的部分（单飞、错误态）由那边覆盖，这里只锁这张表特有的东西。
 */

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
  useOperationLogStore.setState(useOperationLogStore.getInitialState())
  useNotificationStore.setState({ notifications: [] })
})

describe('操作日志 store', () => {
  it('load 成功后落倒序条目与存储统计', async () => {
    await useOperationLogStore.getState().load(gatewayWith())

    const state = useOperationLogStore.getState()
    expect(state.status).toBe('ready')
    expect(state.entries).toEqual(SEED_OPERATION_LOGS)
    expect(state.entries.length).toBeGreaterThan(0)
    expect(state.storage?.operationBytes).toBeGreaterThan(0)
  })

  it('load 失败进入错误态并保留中文消息', async () => {
    await useOperationLogStore
      .getState()
      .load(gatewayWith({ operationLogs: async () => { throw new Error('操作日志端点不可用') } }))

    const state = useOperationLogStore.getState()
    expect(state.status).toBe('error')
    expect(state.errorMessage).toBe('操作日志端点不可用')
  })

  it('分类与结果筛选是纯视图状态，默认全部', () => {
    expect(useOperationLogStore.getState().categoryFilter).toBe('all')
    expect(useOperationLogStore.getState().resultFilter).toBe('all')
    useOperationLogStore.getState().setCategoryFilter('database')
    useOperationLogStore.getState().setResultFilter('failure')
    expect(useOperationLogStore.getState().categoryFilter).toBe('database')
    expect(useOperationLogStore.getState().resultFilter).toBe('failure')
  })

  it('清空操作日志：通知已删除的事实，重新读取后只剩一条留痕', async () => {
    const gateway = gatewayWith()
    await useOperationLogStore.getState().load(gateway)
    useOperationLogStore.getState().openClear('operation')

    await useOperationLogStore.getState().clear(gateway)

    const state = useOperationLogStore.getState()
    expect(state.clearTarget).toBeNull()
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]!.category).toBe('logs')
    const notice = useNotificationStore.getState().notifications[0]
    expect(notice?.tone).toBe('success')
    expect(notice?.message).toContain('操作日志已清空')
  })
})
