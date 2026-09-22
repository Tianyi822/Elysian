import { PANEL_PORT } from '@elysian/contracts'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { ALLOWED_HOSTNAMES } from '../server/src/shared/allowedHostnames.ts'
import { SERVER_PORT } from '../server/src/shared/ports.ts'
import { elysianEventsVitePlugin } from './src/adapters/sse/mockEventsPlugin.vite.ts'

/** 代理目标：后端 API server 只在容器内回环监听（端口唯一权威在 server 侧 shared/ports.ts）。 */
const serverTarget = `http://127.0.0.1:${SERVER_PORT}`

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    elysianEventsVitePlugin(),
  ],
  define: {
    'import.meta.env.ELSYIAN_DOCKER': JSON.stringify(process.env.ELSYIAN_DOCKER ?? ''),
  },
  server: {
    // 面板端口取契约的 PANEL_PORT（唯一权威，compose 端口发布同值）：
    // 它同时是防火墙规则配置的禁区与保底放行端口，三处必须一起变。
    port: PANEL_PORT,
    // 本地原生 dev 只监听 localhost：工作台与无鉴权端点不暴露给局域网；容器编排（ELSYIAN_DOCKER=1）
    // 需要绑 0.0.0.0 才能被宿主机经端口映射访问（compose 只发布到宿主回环）。
    host: process.env.ELSYIAN_DOCKER === '1' ? true : undefined,
    // Host 校验与 server 端守卫共用同一份名单：防 DNS rebinding 是本项目的显式决定，不依赖平台默认。
    allowedHosts: [...ALLOWED_HOSTNAMES],
    watch: process.env.ELSYIAN_DOCKER === '1' ? { usePolling: true } : undefined,
    // 防火墙/SSH/用户管理/文件管理、终端 WebSocket 与平台内存端点由 @elysian/server 承载（仅容器内回环），dev 经代理同源转发；
    // 必须用对象形式且不设 changeOrigin——vite 对字符串简写强制包一层 changeOrigin:true（改写 Host 头，
    // 转发后的 Origin 与 Host 不一致，server 同源守卫将 403 拒掉全部写请求），对象形式才保持原 Host 头。
    // 终端是 WebSocket：多设 ws:true 才代理升级请求（HTTP 代理不转发 Upgrade）。
    // /api/events 与 /api/resources/history 的 SSE 事件流仍由本进程的 elysianEventsVitePlugin 提供，不经代理。
    proxy: {
      '/api/security': { target: serverTarget },
      '/api/platform': { target: serverTarget },
      '/api/files': { target: serverTarget },
      '/api/terminals': { target: serverTarget, ws: true },
    },
  },
  preview: {
    // preview 同款代理：安全、文件管理、终端与平台内存端点已不在本进程挂载，不补则 preview 下这些路径全部失效；
    // 同样必须用对象形式保持原 Host 头（理由见 server.proxy 注释）。
    proxy: {
      '/api/security': { target: serverTarget },
      '/api/platform': { target: serverTarget },
      '/api/files': { target: serverTarget },
      '/api/terminals': { target: serverTarget, ws: true },
    },
  },
})
