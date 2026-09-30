import type { ElysianGateway } from '../../contracts/adapters'
import { createMockDataset, toIncidentListRows } from './dataset'
import type { MockDataset } from './dataset'
import {
  MockApprovalAdapter,
  MockAuditAdapter,
  MockContainerAdapter,
  MockDependenciesAdapter,
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
import { resetLogsData } from './logsData'
import { resetWebsitesData } from './websitesData'
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
import type { ContainerAdapter, EventsAdapter, TerminalAdapter } from '../../contracts/adapters'
import { useContainersStore } from '../../stores/containersStore'
import { useSessionStore } from '../../stores/sessionStore'

/**
 * 演示网关。事件流默认优先走同源 mock SSE 端点，连不上就降级到内存事件源，
 * 降级状态会出现在页头的标识上。
 *
 * 六个选项都是为了让测试可控：
 * - `eventIntervalMs` 只影响内存降级实现的节奏，测试里调大以避免定时器插入断言；
 * - `eventStream: 'memory'` 直接使用内存事件源，不创建真实 EventSource，
 *   这样测试既不依赖服务端进程，也不会产生指向不存在端点的连接；
 * - `firewall: 'http'` 在 Docker 运行时接通容器内 ufw 的真实端点，缺省仍是内存演示；
 * - `ssh: 'http'` 在 Docker 运行时接通容器内 sshd 的真实端点，缺省仍是内存演示；
 * - `users: 'http'` 在 Docker 运行时接通容器内系统账号的真实端点，缺省仍是内存演示；
 * - `files: 'http'` 在 Docker 运行时接通容器内文件管理的真实端点，缺省仍是内存演示；
 * - `containers: 'http'` 在 Docker 运行时接通容器内只读列表的真实端点，缺省仍是内存演示；
 * - `websites: 'http'` 在 Docker 运行时接通容器内网站管理的真实端点（容器、站点目录
 *   与宿主 Caddy 配置），缺省仍是内存演示；
 * - `dependencies: 'http'` 在 Docker 运行时接通宿主依赖检测的真实端点
 *   （/api/platform/dependencies，现场探测 Docker 与 Caddy 通道），缺省恒双 ok 不引导；
 * - `logs: 'http'` 在 Docker 运行时接通容器内平台日志的真实端点（运行、操作与登录三类）；
 * - `terminals: 'ws'` 在 Docker 运行时经 WebSocket 接容器内真实 PTY，缺省仍是内存演示；
 * - `session: 'http'` 在 Docker 运行时经 /api/auth 承载真实会话（登录/登出/探测），
 *   缺省仍是演示放行（不强制登录）。
 *
 * 数据库域没有 mock 取值：始终走 HTTP adapter（`/api/databases`），
 * 端点不可达时页面按既有错误态呈现。
 */
export function createMockGateway(
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
  } = {},
): ElysianGateway {
  let dataset = createMockDataset()
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
  // 日志：容器内三类都走 /api/logs；宿主机本地开发读内存种子。
  const logs = options.logs === 'http' ? createHttpLogsAdapter() : new MockLogsAdapter()
  // 网站：Docker 运行时经 /api/websites 落真实容器、站点目录与宿主 Caddy 配置；
  // 宿主机本地开发保留内存演示（macOS 开发宿主没有 Docker Engine 与 caddy socket）。
  const websites =
    options.websites === 'http' ? createHttpWebsitesAdapter() : new MockWebsitesAdapter()
  // 依赖检测：Docker 运行时接 /api/platform/dependencies 现场探测；本地开发恒双 ok，
  // 引导弹窗永不出现（要看引导效果走容器环境或组件测试注入）。
  const dependencies =
    options.dependencies === 'http' ? createHttpDependenciesAdapter() : new MockDependenciesAdapter()
  // 会话：Docker 运行时经 /api/auth 承载真实登录；演示模式不强制登录——mock 装配即
  // 同步落位「演示放行」的会话态（adapter→store 的先例见上方 useContainersStore），
  // 界面与测试的首屏渲染不必等探测返回；'http' 分支留给 RequireSession 挂载时异步探测。
  const session = options.session === 'http' ? createHttpSessionAdapter() : new MockSessionAdapter()
  if (options.session !== 'http') {
    useSessionStore.setState({ phase: 'authed', mode: 'demo', devAccount: false })
  }

  return {
    session,
    incidents: new MockIncidentAdapter(read),
    runs: new MockRunAdapter(read),
    skills: new MockSkillAdapter(read),
    approvals: new MockApprovalAdapter(read),
    audit: new MockAuditAdapter(read),
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
    events: attachDockerContainerWatch(
      wrapLive(
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
        read,
      ),
      containers,
      useHttpContainers,
    ),
    async reset() {
      dataset = createMockDataset()
      containerEvents.reset()
      resetSshData()
      resetFirewallData()
      resetFilesData()
      resetHostUsers()
      resetLogsData()
      resetWebsitesData()
      terminals.reset()
    },
  }
}

/**
 * 事件回灌包装：新事故在转发给界面之前先落进共享数据集，
 * 手动刷新重新聚合时与实时视图保持一致。
 */
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
