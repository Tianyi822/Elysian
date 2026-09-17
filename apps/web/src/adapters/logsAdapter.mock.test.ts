import { describe, expect, it } from 'vitest'
import { runLogsAdapterContract } from './logsAdapterContract'
import { SEED_LOGIN_LOGS } from './mock/logsData'
import { createMockGateway } from './mock/gateway'

// 契约集合只依赖 LogsAdapter 接口，对 mock 实现的 logs 接缝运行。
runLogsAdapterContract(createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' }).logs)

describe('日志适配器 mock 数据形状', () => {
  // 契约集合里的「两次读取相等」对同一引用的 mock 恒真，确定性由这条 mock 侧断言锁住；
  // 登录记录非空与日志体积量级是演示数据属性，不进契约集合，留在 mock 侧断言。
  it('登录日志 mock：非空且读取结果与种子完全一致', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const entries = await gateway.logs.loginLogs()
    expect(entries.length).toBeGreaterThan(0)
    expect(entries).toEqual(SEED_LOGIN_LOGS)
  })

  it('运行日志 mock：整份内容在十几 KB 量级', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    expect((await gateway.logs.runtimeLog()).sizeBytes).toBeGreaterThan(10 * 1024)
  })
})
