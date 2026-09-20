import type { ElysianGateway } from '../../contracts/adapters'
import { createMockDataset, toIncidentListRows } from './dataset'
import type { MockDataset } from './dataset'
import {
  MockApprovalAdapter,
  MockAuditAdapter,
  MockContainerAdapter,
  MockDatabaseAdapter,
  MockFilesAdapter,
  MockFirewallAdapter,
  MockIncidentAdapter,
  MockLogsAdapter,
  MockRunAdapter,
  MockSessionAdapter,
  MockSkillAdapter,
  MockSshAdapter,
  MockUserAdapter,
  MockWebsitesAdapter,
  createInMemoryEventsAdapter,
} from './mockAdapters'
import { createResilientEventsAdapter } from '../sse/eventsAdapter'
import { createContainerEventsLayer } from './containerEvents'
import { applyIncidentCreated } from './dataset'
import { resetSshData } from './sshData'
import { resetFirewallData } from './firewallData'
import { resetFilesData } from './filesData'
import { resetHostUsers } from './usersData'
import { resetWebsitesData } from './websitesData'
import { MockTerminalAdapter } from './terminalAdapter'
import { MockResourceHistoryAdapter } from './resourceHistoryAdapter'
import { createHttpResourceHistoryAdapter } from '../http/resourceHistoryAdapter'
import { createHttpFirewallAdapter } from '../http/firewallHttpAdapter'
import { createHttpSshAdapter } from '../http/sshHttpAdapter'
import { createHttpUsersAdapter } from '../http/usersHttpAdapter'
import type { EventsAdapter } from '../../contracts/adapters'

/**
 * 演示网关。事件流默认优先走同源 mock SSE 端点，连不上就降级到内存事件源，
 * 降级状态会出现在页头的标识上。
 *
 * 四个选项都是为了让测试可控：
 * - `eventIntervalMs` 只影响内存降级实现的节奏，测试里调大以避免定时器插入断言；
 * - `eventStream: 'memory'` 直接使用内存事件源，不创建真实 EventSource，
 *   这样测试既不依赖服务端进程，也不会产生指向不存在端点的连接；
 * - `firewall: 'http'` 在 Docker 运行时接通容器内 ufw 的真实端点，缺省仍是内存演示；
 * - `ssh: 'http'` 在 Docker 运行时接通容器内 sshd 的真实端点，缺省仍是内存演示；
 * - `users: 'http'` 在 Docker 运行时接通容器内系统账号的真实端点，缺省仍是内存演示。
 */
export function createMockGateway(
  options: {
    eventIntervalMs?: number
    eventStream?: 'auto' | 'memory'
    firewall?: 'mock' | 'http'
    ssh?: 'mock' | 'http'
    users?: 'mock' | 'http'
  } = {},
): ElysianGateway {
  let dataset = createMockDataset()
  const read = () => dataset
  const eventIntervalMs = options.eventIntervalMs ?? 5000
  const containerEvents = createContainerEventsLayer(read, { intervalMs: eventIntervalMs })
  const terminals = new MockTerminalAdapter()
  const resources =
    options.eventStream === 'memory'
      ? new MockResourceHistoryAdapter()
      : createHttpResourceHistoryAdapter()
  const firewall =
    options.firewall === 'http' ? createHttpFirewallAdapter() : new MockFirewallAdapter()
  const ssh = options.ssh === 'http' ? createHttpSshAdapter() : new MockSshAdapter()
  const users = options.users === 'http' ? createHttpUsersAdapter() : new MockUserAdapter()

  return {
    session: new MockSessionAdapter(),
    incidents: new MockIncidentAdapter(read),
    runs: new MockRunAdapter(read),
    skills: new MockSkillAdapter(read),
    approvals: new MockApprovalAdapter(read),
    audit: new MockAuditAdapter(read),
    containers: new MockContainerAdapter(read, {
      onAction: (containerId) => {
        containerEvents.markControlled(containerId)
        containerEvents.emitUpdated(containerId)
      },
      scheduleRestart: (containerId) => containerEvents.scheduleRestart(containerId),
      onCreate: (containerId) => containerEvents.emitCreated(containerId),
    }),
    databases: new MockDatabaseAdapter(),
    firewall,
    ssh,
    users,
    files: new MockFilesAdapter(),
    logs: new MockLogsAdapter(),
    terminals,
    websites: new MockWebsitesAdapter(),
    resources,
    events: wrapLive(
      containerEvents.wrap(
        options.eventStream === 'memory'
          ? createInMemoryEventsAdapter(read, { intervalMs: eventIntervalMs })
          : createResilientEventsAdapter({
              url: '/api/events',
              fallback: () => createInMemoryEventsAdapter(read, { intervalMs: eventIntervalMs }),
            }),
      ),
      read,
    ),
    async reset() {
      dataset = createMockDataset()
      containerEvents.reset()
      resetSshData()
      resetFirewallData()
      resetFilesData()
      resetHostUsers()
      resetWebsitesData()
      terminals.reset()
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
