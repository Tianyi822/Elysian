import { PANEL_PORT } from '@elysian/contracts'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { elysianEventsVitePlugin } from './src/adapters/sse/mockEventsPlugin.vite.ts'

/** 后端 API 服务的契约端口：唯一权威在 Go 侧 apps/server-go/internal/config 的 ListenPort。 */
export const API_PORT = 48101

/** 缺省代理目标：宿主机直跑 Go 后端（go run ./cmd/elysian，监听本机回环契约端口）。 */
export const DEFAULT_API_ORIGIN = `http://127.0.0.1:${API_PORT}`

/** 代理目标：web 容器内开发时由根 docker-compose.yml 注入 ELYSIAN_API_ORIGIN 指向 go-dev 容器。 */
const apiOrigin = process.env.ELYSIAN_API_ORIGIN ?? DEFAULT_API_ORIGIN

/**
 * Host 允许名单：写请求的 Host 头必须解析到名单内的本机地址。Origin 与 Host 互相一致
 * 挡不住 DNS rebinding（攻击域名两头上自身一致），名单把可写的访问面钉死在本机回环；
 * Go 侧 apps/server-go/internal/shared/allowedhostnames.go 是同一份清单，两道防线是
 * 一个显式决定，不依赖平台默认。
 */
const ALLOWED_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']

/**
 * dev 与 preview 共享的 API 代理配置。必须用对象形式且不设 changeOrigin——vite 对字符串简写
 * 强制包一层 changeOrigin:true（改写 Host 头，转发后 Origin 与 Host 不一致，server 同源守卫
 * 将 403 拒掉全部写请求），对象形式才保持原 Host 头。
 * 终端/docker/databases 是 WebSocket，需额外设 ws:true 才代理升级请求。
 * /api/events 与 /api/resources/history 的 SSE 事件流由 elysianEventsVitePlugin 提供，不经代理。
 */
const apiProxy = {
	'/api/panel': { target: apiOrigin },
	'/api/health': { target: apiOrigin },
  '/api/security': { target: apiOrigin, timeout: 65_000, proxyTimeout: 65_000 },
  '/api/platform': {
    target: apiOrigin,
    // 依赖安装含 apt 与官方安装脚本，一步可能要数分钟。
    timeout: 400_000,
    proxyTimeout: 400_000,
  },
  '/api/auth': { target: apiOrigin },
  '/api/files': { target: apiOrigin },
  '/api/logs': { target: apiOrigin },
  '/api/docker': { target: apiOrigin, ws: true },
  '/api/container-apps': { target: apiOrigin },
  '/api/databases': { target: apiOrigin, ws: true },
  '/api/websites': { target: apiOrigin },
  '/api/terminals': { target: apiOrigin, ws: true },
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    elysianEventsVitePlugin(),
  ],
  define: {
    'import.meta.env.ELYSIAN_DOCKER': JSON.stringify(process.env.ELYSIAN_DOCKER ?? ''),
  },
  server: {
    // 面板端口取契约的 PANEL_PORT（唯一权威，compose 端口发布同值）：
    // 它同时是防火墙规则配置的禁区与保底放行端口，三处必须一起变。
    port: PANEL_PORT,
    // 本地原生 dev 只监听 localhost：工作台与无鉴权端点不暴露给局域网；容器编排（ELYSIAN_DOCKER=1）
    // 需要绑 0.0.0.0 才能被宿主机经端口映射访问（compose 只发布到宿主回环）。
    host: process.env.ELYSIAN_DOCKER === '1' ? true : undefined,
    // Host 校验与 server 端守卫共用同一份名单：防 DNS rebinding 是本项目的显式决定，不依赖平台默认。
    allowedHosts: [...ALLOWED_HOSTNAMES],
    watch: process.env.ELYSIAN_DOCKER === '1' ? { usePolling: true } : undefined,
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
})
