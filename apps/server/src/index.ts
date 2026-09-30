import { serve } from 'bun'
import { createApp } from './app.ts'
import { createFileCredentialsStore, ensureFirstBootCredentials } from './auth/credentialsStore.ts'
import { isDevAccountEnabled } from './auth/authConfig.ts'
import { createLogsHostDeps } from './logs/logsHostDeps.ts'
import { SERVER_PORT } from './shared/ports.ts'
import { bunWebSocket } from './terminals/bunWebSocket.ts'

/*
 * Elysian API server 入口：Bun.serve 承载 Hono 应用，只监听本机回环
 * （127.0.0.1，端口见 shared/ports.ts 的唯一权威）。开发形态下 vite 经
 * server.proxy 把 /api/security 与 /api/platform 转发到这里，浏览器始终
 * 走同源 vite 访问；本端口不发布宿主端口、不监听 0.0.0.0，局域网不可达。
 *
 * 日志接线在这里构造并交给 createApp：装配本身不碰文件系统，目录创建、巡检定
 * 时器都发生在第一次写入之后。启动行**写在 index.ts 而不是 createApp 里**，
 * 正是为了让测试调用 createApp() 时不产生任何文件系统副作用（启动行是唯一必须
 * 由装配层写的一条记录，其余由采集中间件与各调用点自己写）。
 *
 * 首启凭据保障同样在这里：dev 开关开时只打警告行；否则凭据文件缺失时生成随机
 * 初始密码（横幅只打 stdout、不落日志文件），运行日志只记一条不含明文的事实。
 */
const logs = createLogsHostDeps()
const credentials = createFileCredentialsStore()
const boot = await ensureFirstBootCredentials(credentials, { dev: isDevAccountEnabled() })
if (boot === 'created') {
  await logs.service.log('info', 'server.lifecycle', '面板初始密码已生成（admin）')
}
const app = await createApp({ logs: logs.service, auth: { credentials } })

serve({
  hostname: '127.0.0.1',
  port: SERVER_PORT,
  // 缺省 10 秒：连接上无字节流动即被服务端关闭。依赖安装的一步在宿主上跑 apt，
  // 最长 240 秒内没有任何响应字节，中途被掐断后 vite 代理只能给浏览器回 502
  // （脚本仍在宿主继续跑完，形成「报错但实际装好了」）。取 Bun 上限 255 秒，
  // 顺序保持：步骤自身超时（≤240s）先触发并回 422，连接超时兜底其后，vite 代理
  // 的 400 秒再兜外层。只影响 HTTP 连接，WebSocket 的空闲超时在 websocket 选项里。
  idleTimeout: 255,
  // 第二参数（Bun server 实例）必须传给 app.fetch：hono/bun 的 upgradeWebSocket
  // 从 fetch 的第二参数取实例，丢弃它会让 /api/terminals/ws 升级抛 TypeError。
  fetch: (request, server) => app.fetch(request, server),
  // 终端 WS 的连接事件处理器：与路由侧 upgradeWebSocket 必须同源（bunWebSocket.ts
  // 的进程级唯一实例），多次 createBunWebSocket 会产出互不相识的两组处理器。
  // maxPayloadLength 必须并入该 handler 对象（顶层 serve 选项不生效）：64 KiB 取全
  // 模块最大合法帧（数据库终端 64 KiB、terminals 应用层 8 KiB 均被覆盖），超限帧
  // 在传输层即 1006 断连、message 回调不触发，不再先缓冲默认 16 MiB 再被应用层拒绝。
  websocket: { ...bunWebSocket.websocket, maxPayloadLength: 64 * 1024 },
})

// 终端上的可读性保留：监听确认行照旧打在 stdout（运行日志文件是它的存档，不是它的替代）。
console.log(`Elysian server 已监听 http://127.0.0.1:${SERVER_PORT}`)

await logs.service.log('info', 'server.lifecycle', `Elysian 服务已启动：http://127.0.0.1:${SERVER_PORT}`)
