import { createMockGateway } from './mock/gateway'
import { runResourceHistoryContract } from './resourceHistoryContract'

runResourceHistoryContract(
  createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' }).resources,
)
