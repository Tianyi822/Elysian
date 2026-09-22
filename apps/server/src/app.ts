import { Hono } from 'hono'
import { FILES_MOUNT, createFilesApp } from './files/filesRoutes.ts'
import { createFilesHostDeps } from './files/filesHostDeps.ts'
import { FIREWALL_MOUNT, createFirewallApp } from './firewall/firewallRoutes.ts'
import { resolveFirewallDeps } from './firewall/firewallHostDeps.ts'
import { endpointErrorHandler } from './middleware/guard.ts'
import { createPlatformMemoryApp } from './platformMemory/platformMemoryRoutes.ts'
import { SSH_MOUNT, createSshApp } from './ssh/sshRoutes.ts'
import { createSshHostDeps } from './ssh/sshHostDeps.ts'
import { USERS_MOUNT, createUsersApp } from './users/usersRoutes.ts'
import { createUsersHostDeps } from './users/usersHostDeps.ts'

/*
 * 组装 Elysian server 的 Hono 应用。挂载结构：
 * - /api/health：存活检查，无守卫；
 * - /api/platform/memory：平台内存采样，无容器边界、无同源守卫（与 vite 端点时代一致）；
 * - /api/security/*：安全区三片（防火墙/SSH/用户管理），同源守卫由各片路由在可用性
 *   判定之后自行挂载——顺序 503 → 403 与各片既有行为逐字一致，app 层不代挂；
 * - /api/files：文件管理片，守卫链与安全区三片同构。
 * 错误映射统一走 endpointErrorHandler：带状态码的错误按自带 status 回 4xx，系统侧一律 500。
 */
export async function createApp(): Promise<Hono> {
  // strict:false：用户管理根路径的带/无尾斜杠双形（浏览器 http adapter 用 `${baseUrl}/` 请求）
  // 都必须命中列表端点，默认 strict 下带尾斜杠形会 404。副作用是其余端点的带尾斜杠形
  // 从 404 放宽为同路由匹配（已知行为放宽，浏览器 adapter 不产生这些请求形）。
  const app = new Hono({ strict: false })
  app.onError(endpointErrorHandler)
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.route('/api/platform', createPlatformMemoryApp())
  // 防火墙接线是 async：规则时间账本依赖 bun:sqlite，仅在容器分支动态加载。
  app.route(FIREWALL_MOUNT, createFirewallApp(await resolveFirewallDeps()))
  app.route(SSH_MOUNT, createSshApp(createSshHostDeps()))
  app.route(USERS_MOUNT, createUsersApp(createUsersHostDeps()))
  app.route(FILES_MOUNT, createFilesApp(createFilesHostDeps()))
  return app
}
