import { serve } from 'bun'
import { createApp } from './app.ts'
import { SERVER_PORT } from './shared/ports.ts'
import { bunWebSocket } from './terminals/bunWebSocket.ts'

/*
 * Elysian API server 入口：Bun.serve 承载 Hono 应用，只监听本机回环
 * （127.0.0.1，端口见 shared/ports.ts 的唯一权威）。开发形态下 vite 经
 * server.proxy 把 /api/security 与 /api/platform 转发到这里，浏览器始终
 * 走同源 vite 访问；本端口不发布宿主端口、不监听 0.0.0.0，局域网不可达。
 */
const app = await createApp()

serve({
  hostname: '127.0.0.1',
  port: SERVER_PORT,
  // 第二参数（Bun server 实例）必须传给 app.fetch：hono/bun 的 upgradeWebSocket
  // 从 fetch 的第二参数取实例，丢弃它会让 /api/terminals/ws 升级抛 TypeError。
  fetch: (request, server) => app.fetch(request, server),
  // 终端 WS 的连接事件处理器：与路由侧 upgradeWebSocket 必须同源（bunWebSocket.ts
  // 的进程级唯一实例），多次 createBunWebSocket 会产出互不相识的两组处理器。
  websocket: bunWebSocket.websocket,
})

console.log(`Elysian server 已监听 http://127.0.0.1:${SERVER_PORT}`)
