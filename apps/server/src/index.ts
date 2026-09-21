import { serve } from 'bun'
import { createApp } from './app.ts'

/*
 * Elysian API server 入口：Bun.serve 承载 Hono 应用，只监听本机回环 127.0.0.1:8080。
 * 开发形态下 vite（5173）经 server.proxy 把 /api/security 与 /api/platform 转发到这里，
 * 浏览器始终走同源 vite 访问；8080 不对局域网发布。
 */
const app = await createApp()

serve({
  hostname: '127.0.0.1',
  port: 8080,
  fetch: (request) => app.fetch(request),
})

console.log('Elysian server 已监听 http://127.0.0.1:8080')
