import { Hono } from 'hono'
import { createFilesApp, type FilesAppDeps } from './files/filesRoutes.ts'
import { createFilesHostDeps } from './files/filesHostDeps.ts'
import { createFirewallApp, type FirewallAppDeps } from './firewall/firewallRoutes.ts'
import { resolveFirewallDeps } from './firewall/firewallHostDeps.ts'
import { createLogsHostDeps } from './logs/logsHostDeps.ts'
import { createOperationAudit } from './logs/operationAudit.ts'
import { createLogsApp } from './logs/logsRoutes.ts'
import type { LogsService } from './logs/logsService.ts'
import { endpointErrorHandler } from './middleware/guard.ts'
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
import { existsSync } from 'node:fs'
import {
  DOCKER_MOUNT,
  DATABASE_MOUNT,
  FILES_MOUNT,
  FIREWALL_MOUNT,
  LOGS_MOUNT,
  SSH_MOUNT,
  TERMINAL_MOUNT,
  USERS_MOUNT,
} from './shared/apiMounts.ts'

/*
 * 组装 Elysian server 的 Hono 应用。挂载结构：
 * - /api/health：存活检查，无守卫；
 * - /api/platform/memory：平台内存采样，无容器边界、无同源守卫（与 vite 端点时代一致）；
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
 * 装配期不写任何日志、不建任何目录：日志目录创建与巡检定时器都发生在第一次 append 之后，
 * 因此任何调用 createApp 的测试都不会碰开发者真实的 ~/.Elysian/logs。
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

  app.get('/api/health', (c) => c.json({ ok: true }))
  app.route('/api/platform', createPlatformMemoryApp())
  // 防火墙接线是 async：规则时间账本依赖 bun:sqlite，仅在容器分支动态加载。
  app.route(FIREWALL_MOUNT, createFirewallApp(overrides.firewall ?? (await resolveFirewallDeps())))
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
      }) }
    : { available: sqliteAvailable, sqlite: sqliteAvailable ? createSqliteService({ uid: 2001, gid: 2001, bunBin: '/usr/local/bin/bun' }) : undefined })
  app.route(DATABASE_MOUNT, createDatabaseApp({ ...databases, logs: databases.logs ?? logs }))
  return app
}
