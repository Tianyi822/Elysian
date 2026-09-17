import { describe, expect, it } from 'vitest'
import { runLogsAdapterContract } from './logsAdapterContract'
import { SEED_LOGIN_LOGS } from './mock/logsData'
import { createMockGateway } from './mock/gateway'

describe('日志适配器契约（mock 实现）', () => {
  runLogsAdapterContract(createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' }))

  // 契约集合里的「两次读取相等」对同一引用的 mock 恒真，确定性由这条 mock 侧断言锁住。
  it('登录日志 mock：读取结果与种子完全一致', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    expect(await gateway.logs.loginLogs()).toEqual(SEED_LOGIN_LOGS)
  })
})
