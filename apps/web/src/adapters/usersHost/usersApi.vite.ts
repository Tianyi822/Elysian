import type { Plugin } from 'vite'

/** Vite 入口：Vitest 不加载本文件；dev/preview 动态挂载用户管理的 Node 中间件。 */
export function elysianUsersVitePlugin(): Plugin {
  return {
    name: 'elysian-security-users-api',
    async configureServer(server) {
      const { createSecurityUsersMiddleware } = await import('./api.node.ts')
      server.middlewares.use('/api/security/users', createSecurityUsersMiddleware())
    },
    async configurePreviewServer(server) {
      const { createSecurityUsersMiddleware } = await import('./api.node.ts')
      server.middlewares.use('/api/security/users', createSecurityUsersMiddleware())
    },
  }
}
