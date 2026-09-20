import type { Plugin } from 'vite'

/** Vite 入口：Vitest 不加载本文件；dev/preview 动态挂载 SSH 管理的 Node 中间件。 */
export function elysianSshVitePlugin(): Plugin {
  return {
    name: 'elysian-security-ssh-api',
    async configureServer(server) {
      const { createSecuritySshMiddleware } = await import('./api.node.ts')
      server.middlewares.use('/api/security/ssh', createSecuritySshMiddleware())
    },
    async configurePreviewServer(server) {
      const { createSecuritySshMiddleware } = await import('./api.node.ts')
      server.middlewares.use('/api/security/ssh', createSecuritySshMiddleware())
    },
  }
}
