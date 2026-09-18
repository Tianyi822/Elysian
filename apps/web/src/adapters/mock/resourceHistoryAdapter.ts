import type {
  ResourceHistoryAdapter,
  ResourceHistoryTimeRange,
} from '../../contracts/adapters'
import { listMockHistory, seedMockHistoryIfEmpty, type TimeRange } from './resourceMetrics'

export class MockResourceHistoryAdapter implements ResourceHistoryAdapter {
  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  async list(range: ResourceHistoryTimeRange): Promise<ReturnType<typeof listMockHistory>> {
    const nowMs = this.nowMs()
    seedMockHistoryIfEmpty(nowMs)
    return listMockHistory(range as TimeRange, nowMs)
  }
}
