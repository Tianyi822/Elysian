import type { ResourceHistoryAdapter } from '../../contracts/adapters'
import type { TimeRange } from '../../contracts/resourceMetrics'
import { listMockHistory, seedMockHistoryIfEmpty } from './resourceMetrics'

export class MockResourceHistoryAdapter implements ResourceHistoryAdapter {
  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  async list(range: TimeRange): Promise<ReturnType<typeof listMockHistory>> {
    const nowMs = this.nowMs()
    seedMockHistoryIfEmpty(nowMs)
    return listMockHistory(range, nowMs)
  }
}
