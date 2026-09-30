import { beforeEach, describe, expect, it } from 'vitest'
import type { LoginLogListQuery } from '@elysian/contracts'
import { createMockGateway } from '../adapters/mock/gateway'
import { SEED_LOGIN_LOGS } from '../adapters/mock/logsData'
import type { ElysianGateway } from '../contracts/adapters'
import { useLoginLogStore } from './loginLogStore'

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
  useLoginLogStore.setState(useLoginLogStore.getInitialState())
})

describe('登录日志 store', () => {
  it('load 按状态与搜索传查询参数并写入 total', async () => {
    const calls: LoginLogListQuery[] = []
    const gateway = gatewayWith({
      loginLogs: async (query) => {
        calls.push(query ?? {})
        return {
          entries: SEED_LOGIN_LOGS.slice(0, 1),
          total: 5,
          truncated: true,
          skippedLines: 0,
          skippedFiles: 0,
        }
      },
    })
    useLoginLogStore.getState().setStatusFilter('failure')
    useLoginLogStore.getState().setSearch(' 114.135 ')
    await useLoginLogStore.getState().load(gateway)

    expect(calls.at(-1)).toEqual({ status: 'failure', q: '114.135' })
    expect(useLoginLogStore.getState().total).toBe(5)
    expect(useLoginLogStore.getState().truncated).toBe(true)
  })

  it('loadOlder 用 time 作为 before', async () => {
    const page1 = SEED_LOGIN_LOGS.slice(0, 2)
    const page2 = SEED_LOGIN_LOGS.slice(2, 4)
    const calls: LoginLogListQuery[] = []
    const gateway = gatewayWith({
      loginLogs: async (query) => {
        calls.push(query ?? {})
        if (query?.before) {
          return { entries: page2, total: 4, truncated: false, skippedLines: 0, skippedFiles: 0 }
        }
        return { entries: page1, total: 4, truncated: true, skippedLines: 0, skippedFiles: 0 }
      },
    })
    await useLoginLogStore.getState().load(gateway)
    await useLoginLogStore.getState().loadOlder(gateway)
    expect(useLoginLogStore.getState().entries).toEqual([...page1, ...page2])
    expect(calls.at(-1)?.before).toBe(page1[page1.length - 1]!.time)
  })
})
