import { mockPanelAdapter } from './panelMock'
import { createHttpPanelAdapter } from '../http/panelHttpAdapter'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockDataset } from './dataset'
import {
  MockContainerAdapter,
  MockDependenciesAdapter,
  MockFilesAdapter,
  MockFirewallAdapter,
  MockLogsAdapter,
  MockSessionAdapter,
  MockSshAdapter,
  MockUserAdapter,
  MockWebsitesAdapter,
  createInMemoryEventsAdapter,
} from './mockAdapters'
import { createResilientEventsAdapter } from '../sse/eventsAdapter'
import { createContainerEventsLayer } from './containerEvents'
import { createHttpLogsAdapter } from '../http/logsHttpAdapter'
import { MockTerminalAdapter } from './terminalAdapter'
import { MockResourceHistoryAdapter } from './resourceHistoryAdapter'
import { createHttpResourceHistoryAdapter } from '../http/resourceHistoryAdapter'
import { createHttpFirewallAdapter } from '../http/firewallHttpAdapter'
import { createHttpSshAdapter } from '../http/sshHttpAdapter'
import { createHttpUsersAdapter } from '../http/usersHttpAdapter'
import { createHttpFilesAdapter } from '../http/filesHttpAdapter'
import { createHttpContainersAdapter } from '../http/containersHttpAdapter'
import { createHttpWebsitesAdapter } from '../http/websitesHttpAdapter'
import { createHttpDependenciesAdapter } from '../http/dependenciesHttpAdapter'
import { createHttpSessionAdapter } from '../http/sessionHttpAdapter'
import { createTerminalWsAdapter } from '../http/terminalWsAdapter'
import { createHttpDatabaseAdapter } from '../http/databaseHttpAdapter'
import { createHttpAgentWikiReadAdapter } from '../http/agentWikiReadHttpAdapter'
import type { AgentWikiReadAdapter, ContainerAdapter, EventsAdapter, TerminalAdapter } from '../../contracts/adapters'
import { useContainersStore } from '../../stores/containersStore'
import { useSessionStore } from '../../stores/sessionStore'

/**
 * 网关工厂。事件流默认优先走同源 mock SSE 端点，连不上就降级到内存事件源，
 * 降级状态会出现在页头的标识上。
 *
 * 各选项让测试可控，并在 Docker 运行时切换到真实 HTTP/WebSocket 适配器：
 * - `eventIntervalMs` 只影响内存降级实现的节奏；
 * - `eventStream: 'memory'` 直接使用内存事件源，不创建真实 EventSource；
 * - `firewall/ssh/users/files/containers/websites/dependencies/logs/session: 'http'`
 *   在 Docker 运行时接通对应的真实端点，缺省仍是内存演示；
 * - `terminals: 'ws'` 在 Docker 运行时经 WebSocket 接容器内真实 PTY；
 * - `session: 'http'` 在 Docker 运行时经 /api/auth 走真实登录。
 * - `wiki: 'http'` 在 Docker 运行时读取真实 Agent Wiki，演示模式明确为空。
 *
 * 数据库域没有 mock 取值：始终走 HTTP adapter（/api/databases）。
 */
export function createGateway(
  options: {
    eventIntervalMs?: number
    eventStream?: 'auto' | 'memory'
    firewall?: 'mock' | 'http'
    ssh?: 'mock' | 'http'
    users?: 'mock' | 'http'
    files?: 'mock' | 'http'
    containers?: 'mock' | 'http'
    websites?: 'mock' | 'http'
    dependencies?: 'mock' | 'http'
    logs?: 'mock' | 'http'
    terminals?: 'mock' | 'ws'
    session?: 'mock' | 'http'
    panel?: 'mock' | 'http'
    wiki?: 'mock' | 'http'
  } = {},
): ElysianGateway {
  const dataset = createMockDataset()
  const read = () => dataset
  const eventIntervalMs = options.eventIntervalMs ?? 5000
  const containerEvents = createContainerEventsLayer(read, { intervalMs: eventIntervalMs })
  const terminals: TerminalAdapter & { reset(): void } =
    options.terminals === 'ws' ? createTerminalWsAdapter() : new MockTerminalAdapter()
  const resources =
    options.eventStream === 'memory'
      ? new MockResourceHistoryAdapter()
      : createHttpResourceHistoryAdapter()
  const firewall =
    options.firewall === 'http' ? createHttpFirewallAdapter() : new MockFirewallAdapter()
  const ssh = options.ssh === 'http' ? createHttpSshAdapter() : new MockSshAdapter()
  const users = options.users === 'http' ? createHttpUsersAdapter() : new MockUserAdapter()
  const files = options.files === 'http' ? createHttpFilesAdapter() : new MockFilesAdapter()
  const useHttpContainers = options.containers === 'http'
  const containers =
    useHttpContainers
      ? createHttpContainersAdapter()
      : new MockContainerAdapter(read, {
          onAction: (containerId) => {
            containerEvents.markControlled(containerId)
            containerEvents.emitUpdated(containerId)
          },
          scheduleRestart: (containerId) => containerEvents.scheduleRestart(containerId),
          onCreate: (containerId) => containerEvents.emitCreated(containerId),
        })
  const logs = options.logs === 'http' ? createHttpLogsAdapter() : new MockLogsAdapter()
  const websites =
    options.websites === 'http' ? createHttpWebsitesAdapter() : new MockWebsitesAdapter()
  const dependencies =
    options.dependencies === 'http' ? createHttpDependenciesAdapter() : new MockDependenciesAdapter()
  const session = options.session === 'http' ? createHttpSessionAdapter() : new MockSessionAdapter()
  if (options.session !== 'http') {
    useSessionStore.setState({ phase: 'authed', mode: 'demo', devAccount: false })
  }

  return {
    panel: options.panel === 'http' ? createHttpPanelAdapter() : mockPanelAdapter,
    session,
    containers,
    databases: createHttpDatabaseAdapter(),
    firewall,
    ssh,
    users,
    files,
    logs,
    terminals,
    websites,
    resources,
    dependencies,
    wiki: options.wiki === 'http' ? createHttpAgentWikiReadAdapter() : createMockWikiReadAdapter(),
    events: attachDockerContainerWatch(
      useHttpContainers
        ? options.eventStream === 'memory'
          ? createInMemoryEventsAdapter(read, { intervalMs: eventIntervalMs })
          : createResilientEventsAdapter({
              url: '/api/events',
              fallback: () => createInMemoryEventsAdapter(read, { intervalMs: eventIntervalMs }),
            })
        : containerEvents.wrap(
            options.eventStream === 'memory'
              ? createInMemoryEventsAdapter(read, { intervalMs: eventIntervalMs })
              : createResilientEventsAdapter({
                  url: '/api/events',
                  fallback: () => createInMemoryEventsAdapter(read, { intervalMs: eventIntervalMs }),
                }),
          ),
      containers,
      useHttpContainers,
    ),
  }
}

/** 演示模式不伪造 Wiki 内容，详情请求明确报告暂无可读数据。 */
export function createMockWikiReadAdapter(): AgentWikiReadAdapter {
  const unavailable = async (): Promise<never> => { throw new Error('演示模式暂无 Wiki 数据') }
  return {
    available: false,
    listSpaces: async () => [],
    listPages: async () => [],
    getPage: unavailable,
    getPageRevision: unavailable,
    search: async () => ({ items: [], degraded: true, reason: '演示模式暂无 Wiki 数据' }),
  }
}

/** 向后兼容的别名，仍被测试文件等引用（逐步迁移到 createGateway）。 */
export { createGateway as createMockGateway }

/**
 * Docker 容器列表走 HTTP 时，容器事件来自 watchLive 而非 mock 采样层；
 * onStatus 只更新容器 store，不写入全局事件流状态。
 */
function attachDockerContainerWatch(
  underlying: EventsAdapter,
  containers: ContainerAdapter,
  enabled: boolean,
): EventsAdapter {
  if (!enabled) return underlying
  return {
    subscribe(handlers) {
      const unsubscribeEvents = underlying.subscribe(handlers)
      const unsubscribeWatch = containers.watchLive({
        onEvent: handlers.onEvent,
        onStatus: (status) => {
          useContainersStore.getState().setLiveStatus(status)
        },
      })
      return () => {
        unsubscribeEvents()
        unsubscribeWatch()
      }
    },
  }
}
