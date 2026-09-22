import { serve } from 'bun'
import { createApp } from './app.ts'
import { SERVER_PORT } from './shared/ports.ts'

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
  fetch: (request) => app.fetch(request),
})

console.log(`Elysian server 已监听 http://127.0.0.1:${SERVER_PORT}`)
