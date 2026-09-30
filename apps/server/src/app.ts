import { Hono } from 'hono'
import { createFilesApp, type FilesAppDeps } from './files/filesRoutes.ts'
import { createFilesHostDeps } from './files/filesHostDeps.ts'
import { createFirewallApp, type FirewallAppDeps } from './firewall/firewallRoutes.ts'
import { resolveFirewallDeps } from './firewall/firewallHostDeps.ts'
import { ensurePortRule } from './firewall/firewallService.ts'
import { createLogsHostDeps } from './logs/logsHostDeps.ts'
import { createOperationAudit } from './logs/operationAudit.ts'
import { createLogsApp } from './logs/logsRoutes.ts'
import type { LogsService } from './logs/logsService.ts'
import { endpointErrorHandler } from './middleware/guard.ts'
import { createDependencyProbe } from './platformDependencies/dependencyProbe.ts'
import { createPlatformDependenciesApp, type PlatformDependenciesAppDeps } from './platformDependencies/platformDependenciesRoutes.ts'
import { createPlatformMemoryApp } from './platformMemory/platformMemoryRoutes.ts'
import { createSshApp, type SshApiDeps } from './ssh/sshRoutes.ts'
import { createSshHostDeps } from './ssh/sshHostDeps.ts'
import { createTerminalsApp, type TerminalsAppDeps } from './terminals/terminalsRoutes.ts'
import { createTerminalsHostDeps } from './terminals/terminalsHostDeps.ts'
import { createUsersApp, type UsersAppDeps } from './users/usersRoutes.ts'
import { createUsersHostDeps } from './users/usersHostDeps.ts'
import { createDockerApp, type DockerAppDeps } from './docker/dockerRoutes.ts'
import { createDockerHostDeps } from './docker/dockerHostDeps.ts'
import { createDatabaseApp, type DatabaseAppDeps } from './database/databaseRoutes.ts'
import { createDatabaseDocker } from './database/databaseDocker.ts'
import { createDatabaseProtocol } from './database/databaseProtocol.ts'
import { createFileDatabaseRegistry } from './database/databaseRegistry.ts'
import { createDatabaseService } from './database/databaseService.ts'
import { createSqliteService } from './database/sqliteService.ts'
import { createWebsitesApp, type WebsitesAppDeps } from './websites/websitesRoutes.ts'
import { createWebsiteCaddy } from './websites/websitesCaddy.ts'
import { createWebsiteDocker } from './websites/websitesDocker.ts'
import { createFileWebsiteRegistry } from './websites/websitesRegistry.ts'
import { createFileWebsiteCertificateStore } from './websites/websitesCertificates.ts'
import { createWebsiteService } from './websites/websitesService.ts'
import { createAuthApp, resolveAuthDeps, type AuthAppDeps } from './auth/authRoutes.ts'
import { requireSession } from './auth/authMiddleware.ts'
import { existsSync } from 'node:fs'
import {
  AUTH_MOUNT,
  DOCKER_MOUNT,
  DATABASE_MOUNT,
  FILES_MOUNT,
  FIREWALL_MOUNT,
  LOGS_MOUNT,
  PLATFORM_MOUNT,
  SSH_MOUNT,
  TERMINAL_MOUNT,
  USERS_MOUNT,
  WEBSITES_MOUNT,
} from './shared/apiMounts.ts'

/*
 * 组装 Elysian server 的 Hono 应用。挂载结构：
 * - /api/health：存活检查，无守卫（鉴权豁免清单内，供容器存活检查）；
 * - /api/auth：登录鉴权片（POST /login、POST /logout、GET /session），三端点在
 *   鉴权豁免清单内（登录流程自身 + 登出幂等），其余 /api/* 一律要求有效会话；
 * - /api/platform/memory：平台内存采样，无容器边界、无同源守卫（与 vite 端点时代一致）；
 * - /api/platform/dependencies：宿主依赖检测（Docker 与 Caddy 通道的就绪性），每次请求
 *   现场探测、纯读，同样无容器边界——Docker 缺失这个事实要在三域全 503 时仍拿得到；
 * - /api/security/*：安全区三片（防火墙/SSH/用户管理），同源守卫由各片路由在可用性
 *   判定之后自行挂载——顺序 503 → 403 与各片既有行为逐字一致，app 层不代挂；
 * - /api/files：文件管理片，守卫链与安全区三片同构；
 * - /api/terminals：终端片（/ws WebSocket 升级 + /status），守卫链同构，升级前同源
 *   校验由 /ws 路由在 upgradeWebSocket 之前前置短路（见 terminalsRoutes）；
 * - /api/logs：平台日志片（运行日志与操作日志的读取、按类别清空），**无容器边界**：
 *   只读写 ~/.Elysian 下面板自有的目录，宿主机本地开发与容器内同一套实现，没有 503 段。
 * 错误映射统一走 endpointErrorHandler：带状态码的错误按自带 status 回 4xx，系统侧一律 500。
 *
 * 采集中间件 app.use('/api/*', createOperationAudit(logs)) **必须注册在所有 app.route 之前**：
 * 中间件按注册顺序包住其后的路由，注册晚了就包不住任何一片。它包住每一个到达服务端的
 * 写请求（含被守卫拒绝的那些），记录内容全部由服务端生成，客户端无法投稿也无法绕开。
 *
 * 鉴权中间件 requireSession 紧随其后（顺序是关键）：审计在前让被 401 拒绝的写请求也
 * 落操作日志；鉴权在全部片路由之前让读写全挡。请求经手次序：401 → 503 → 403 → 端点
 * → 404。
 *
 * 装配期不写任何日志、不建任何目录：日志目录创建与巡检定时器都发生在第一次 append 之后，
 * 因此任何调用 createApp 的测试都不会碰开发者真实的 ~/.Elysian/logs；鉴权的两个 store
 * 同样惰性 IO（首次用到才读文件）。
 */
export type AppDepsOverrides = {
  firewall?: FirewallAppDeps
  ssh?: SshApiDeps
  users?: UsersAppDeps
  files?: FilesAppDeps
  terminals?: TerminalsAppDeps
  /** 日志服务：缺省构造真实接线（构造期零副作用，测试与漂移守卫注入 fake）。 */
  logs?: LogsService
  /** 容器管理片：缺省走真实接线（async 探测 socket 与 API 版本）。 */
  docker?: DockerAppDeps
  databases?: DatabaseAppDeps
  /** 网站管理片：缺省走真实接线（依赖容器片的 transport 与挂载根策略）。 */
  websites?: WebsitesAppDeps
  /** 依赖检测片：缺省走真实接线（每次请求现场探测 Docker 与 Caddy 通道）。 */
  platformDependencies?: PlatformDependenciesAppDeps
  /**
   * 登录鉴权（Partial 覆盖，与 logs、docker 等同模式）：缺省按 resolveAuthDeps 装配
   * （enabled: true、devAccount 读环境开关、真实文件版两个 store、scrypt hasher——
   * 两个 store 都是惰性 IO，createApp 本身不读不写任何文件）。既有测试注入
   * `auth: { enabled: false }` 即回到无鉴权演示语义（中间件与登录片短路）。
   */
  auth?: Partial<AuthAppDeps>
}

/**
 * 覆盖参数是可选的：不传时行为与从前逐字一致（各片构造自己的真实接线），
 * 传入的片用自己的 deps——需要注入 fake 的测试与漂移守卫测试都靠它。
 */
export async function createApp(overrides: AppDepsOverrides = {}): Promise<Hono> {
  // strict:false：用户管理根路径的带/无尾斜杠双形（浏览器 http adapter 用 `${baseUrl}/` 请求）
  // 都必须命中列表端点，默认 strict 下带尾斜杠形会 404。副作用是其余端点的带尾斜杠形
  // 从 404 放宽为同路由匹配（已知行为放宽，浏览器 adapter 不产生这些请求形）。
  const app = new Hono({ strict: false })
  const logs = overrides.logs ?? createLogsHostDeps().service

  // onError 是**兜底**而不是 5xx 的主来源：各子应用都注册了自己的 onError，子应用的 500
  // 由子应用自己映射，父 onError 根本不会被调用；常规 5xx 的运行日志由采集中间件按
  // c.res.status 记。这里只负责「错误在父层或中间件里被抛出」这一路，错误映射一字不变。
  app.onError((error, c) => {
    void logs.log(
      'error',
      'server.http',
      `请求处理失败：${c.req.method} ${c.req.path} — ${error instanceof Error ? error.message : String(error)}`,
    )
    return endpointErrorHandler(error, c)
  })
  app.use('/api/*', createOperationAudit(logs))
  // 登录鉴权：紧随操作审计之后、全部片路由之前，读写全挡（豁免 health 与 auth 三端点，
  // 先剥单个尾斜杠再精确匹配）。中间件先于路由 handler 执行，因此 WS 升级与 SSE 在
  // 升级/开流之前就先过鉴权；401 短路在 upgradeWebSocket 之前以普通 Response 返回。
  // 请求经手次序：401（鉴权）→ 503（各片可用性）→ 403（同源）→ 端点 → 404——鉴权先于
  // 可用性是显式决定：不向未登录方暴露各片可用性事实。
  const auth = resolveAuthDeps(overrides.auth)
  app.use('/api/*', requireSession(auth))

  app.get('/api/health', (c) => c.json({ ok: true }))
  app.route(AUTH_MOUNT, createAuthApp(auth))
  app.route(PLATFORM_MOUNT, createPlatformMemoryApp())
  app.route(PLATFORM_MOUNT, createPlatformDependenciesApp(
    overrides.platformDependencies ?? createDependencyProbe(),
  ))
  // 防火墙接线是 async：规则时间账本依赖 bun:sqlite，仅在容器分支动态加载。
  const firewall = overrides.firewall ?? (await resolveFirewallDeps())
  app.route(FIREWALL_MOUNT, createFirewallApp(firewall))
  // 端口自动开放闭包（网站直连与数据库任意主机访问在创建时调用）：真实接线经
  // ensurePortRule 幂等补规则；测试注入的防火墙片没有 hostDeps，恒报 skipped 不打扰。
  const openFirewallPort = firewall.hostDeps !== undefined
    ? (port: number, note: string) => ensurePortRule(firewall.hostDeps!, { port, note })
    : async (port: number) => ({ state: 'skipped' as const, port, detail: '防火墙片不可用，端口未自动开放' })
  app.route(SSH_MOUNT, createSshApp(overrides.ssh ?? createSshHostDeps()))
  app.route(USERS_MOUNT, createUsersApp(overrides.users ?? createUsersHostDeps()))
  app.route(FILES_MOUNT, createFilesApp(overrides.files ?? createFilesHostDeps()))
  // 终端接线是 async：Bun.spawn（script 管道）只在容器分支动态加载，vitest 的 node
  // 运行时不进 'bun' 模块图（与防火墙片动态加载 bun:sqlite 同一纪律）。
  // 覆盖路径同样要与 logs 合并：漏了这一步不会有任何既有测试变红（终端片把 logs 做成
  // 可选、不传即跳过），但「系统级操作都显示在操作日志」会静默缺掉终端会话这一类。
  const terminals = overrides.terminals ?? (await createTerminalsHostDeps())
  app.route(TERMINAL_MOUNT, createTerminalsApp({ ...terminals, logs: terminals.logs ?? logs }))
  app.route(LOGS_MOUNT, createLogsApp({ service: logs }))
  const docker = overrides.docker ?? (await createDockerHostDeps())
  app.route(DOCKER_MOUNT, createDockerApp({ ...docker, logs: docker.logs ?? logs }))
  const sqliteAvailable = process.env.ELYSIAN_DOCKER === '1' && existsSync('/.dockerenv')
  const databases = overrides.databases ?? (docker.socketReady && docker.transport && docker.service
    ? { available: true, sqlite: sqliteAvailable ? createSqliteService({ uid: 2001, gid: 2001, bunBin: '/usr/local/bin/bun' }) : undefined, service: createDatabaseService({
        registry: createFileDatabaseRegistry(),
        docker: createDatabaseDocker(docker.transport, () => docker.service!.listImages()),
        protocol: createDatabaseProtocol(),
        listImages: () => docker.service!.listImages(),
        listContainers: () => docker.service!.listContainers(),
        selfContainerId: docker.selfContainerId ?? undefined,
        openFirewallPort,
      }) }
    : { available: sqliteAvailable, sqlite: sqliteAvailable ? createSqliteService({ uid: 2001, gid: 2001, bunBin: '/usr/local/bin/bun' }) : undefined })
  app.route(DATABASE_MOUNT, createDatabaseApp({ ...databases, logs: databases.logs ?? logs }))
  // 网站片依赖容器片的 transport 与挂载根策略（policy() 返回挂载根与保留端口）；
  // 站点容器经 Engine API 建在宿主上，反向代理通道经 ELYSIAN_CADDY_SOCKET 的 unix
  // socket 驱动宿主 Caddy（无 caddy 的宿主如实降级，容器生命周期不受影响）。
  // policy 只在真正走缺省接线时才调用：注入 websites 覆盖（漂移守卫的 STUB）不碰它。
  let websites = overrides.websites
  if (!websites) {
    if (docker.socketReady && docker.transport && docker.service && typeof docker.service.policy === 'function') {
      const dockerPolicy = await docker.service.policy()
      websites = { available: true, service: createWebsiteService({
        registry: createFileWebsiteRegistry(),
        certificates: createFileWebsiteCertificateStore(),
        docker: createWebsiteDocker(docker.transport, () => docker.service!.listImages()),
        caddy: createWebsiteCaddy(),
        mountRoot: dockerPolicy.mountRoot,
        listPortBindings: async () => (await docker.service!.listContainers())
          .flatMap((container) => container.ports),
        selfContainerId: docker.selfContainerId ?? undefined,
        openFirewallPort,
      }) }
    } else {
      websites = { available: false }
    }
  }
  app.route(WEBSITES_MOUNT, createWebsitesApp({ ...websites, logs: websites.logs ?? logs }))
  return app
}
