import type { ElysianGateway } from '../../contracts/adapters'
import { createMockDataset, toIncidentListRows } from './dataset'
import type { MockDataset } from './dataset'
import {
  MockApprovalAdapter,
  MockAuditAdapter,
  MockContainerAdapter,
  MockIncidentAdapter,
  MockRunAdapter,
  MockSessionAdapter,
  MockSkillAdapter,
  createInMemoryEventsAdapter,
} from './mockAdapters'
import { createResilientEventsAdapter } from '../sse/eventsAdapter'
import { applyIncidentCreated } from './dataset'
import type { EventsAdapter } from '../../contracts/adapters'

/**
 * 演示网关。事件流默认优先走同源 mock SSE 端点，连不上就降级到内存事件源，
 * 降级状态会出现在页头的标识上。
 *
 * 两个选项都是为了让测试可控：
 * - `eventIntervalMs` 只影响内存降级实现的节奏，测试里调大以避免定时器插入断言；
 * - `eventStream: 'memory'` 直接使用内存事件源，不创建真实 EventSource，
 *   这样测试既不依赖服务端进程，也不会产生指向不存在端点的连接。
 */
export function createMockGateway(
  options: { eventIntervalMs?: number; eventStream?: 'auto' | 'memory' } = {},
): ElysianGateway {
  let dataset = createMockDataset()
  const read = () => dataset
  const eventIntervalMs = options.eventIntervalMs ?? 2000

  return {
    session: new MockSessionAdapter(),
    incidents: new MockIncidentAdapter(read),
    runs: new MockRunAdapter(read),
    skills: new MockSkillAdapter(read),
    approvals: new MockApprovalAdapter(read),
    audit: new MockAuditAdapter(read),
    // 占位 hooks：动作先只改写共享数据集，事件层接线由后续任务替换。
    containers: new MockContainerAdapter(read, {
      onAction: () => {},
      scheduleRestart: () => {},
    }),
    events: wrapLive(options.eventStream === 'memory'
      ? createInMemoryEventsAdapter(read, { intervalMs: eventIntervalMs })
      : createResilientEventsAdapter({
          url: '/api/events',
          fallback: () => createInMemoryEventsAdapter(read, { intervalMs: eventIntervalMs }),
        }), read),
    async reset() {
      dataset = createMockDataset()
    },
  }
}

/**
 * 事件回灌包装：新事故在转发给界面之前先落进共享数据集，
 * 手动刷新重新聚合时与实时视图保持一致。
 */
function wrapLive(underlying: EventsAdapter, getDataset: () => MockDataset): EventsAdapter {
  return {
    subscribe(handlers) {
      return underlying.subscribe({
        onStatus: handlers.onStatus,
        onEvent: (event) => {
          if (event.name === 'incident/created') {
            applyIncidentCreated(getDataset(), event.payload, event.at)
          }
          handlers.onEvent(event)
        },
      })
    },
  }
}

export { toIncidentListRows }
export type { MockDataset }
