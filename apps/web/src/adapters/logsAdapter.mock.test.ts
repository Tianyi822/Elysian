import { describe } from 'vitest'
import { runLogsAdapterContract } from './logsAdapterContract'
import { createMockGateway } from './mock/gateway'

describe('日志适配器契约（mock 实现）', () => {
  runLogsAdapterContract(createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' }))
})
