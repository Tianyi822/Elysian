import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { ALLOWED_HOSTNAMES } from './src/adapters/endpointGuard/guard.ts'
import { elysianEventsVitePlugin } from './src/adapters/sse/mockEventsPlugin.vite.ts'
import { elysianSecurityVitePlugin } from './src/adapters/firewallHost/firewallApi.vite.ts'
import { elysianSshVitePlugin } from './src/adapters/sshHost/sshApi.vite.ts'
import { elysianUsersVitePlugin } from './src/adapters/usersHost/usersApi.vite.ts'

export default defineConfig({
  plugins: [react(), tailwindcss(), elysianEventsVitePlugin(), elysianSecurityVitePlugin(), elysianSshVitePlugin(), elysianUsersVitePlugin()],
  define: {
    'import.meta.env.ELSYIAN_DOCKER': JSON.stringify(process.env.ELSYIAN_DOCKER ?? ''),
  },
  server: {
    port: 5173,
    // 本地原生 dev 只监听 localhost：工作台与无鉴权端点不暴露给局域网；容器编排（ELSYIAN_DOCKER=1）
    // 需要绑 0.0.0.0 才能被宿主机经端口映射访问（compose 只发布到宿主回环）。
    host: process.env.ELSYIAN_DOCKER === '1' ? true : undefined,
    // Host 校验与端点守卫共用同一份名单：防 DNS rebinding 是本项目的显式决定，不依赖平台默认。
    allowedHosts: [...ALLOWED_HOSTNAMES],
    watch: process.env.ELSYIAN_DOCKER === '1' ? { usePolling: true } : undefined,
  },
})
