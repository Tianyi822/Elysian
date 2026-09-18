import type {
  ResourceHistoryAdapter,
  ResourceHistoryTimeRange,
} from '../../contracts/adapters'
import { listMockHistory, type TimeRange } from './resourceMetrics'

export class MockResourceHistoryAdapter implements ResourceHistoryAdapter {
  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  async list(range: ResourceHistoryTimeRange): Promise<ReturnType<typeof listMockHistory>> {
    return listMockHistory(range as TimeRange, this.nowMs())
  }
}
