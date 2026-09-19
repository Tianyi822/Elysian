import type { Plugin } from 'vite'

/** Vite 入口：Vitest 不加载本文件；dev/preview 动态挂载防火墙 Node 中间件。 */
export function elysianSecurityVitePlugin(): Plugin {
  return {
    name: 'elysian-security-firewall-api',
    async configureServer(server) {
      const { createSecurityFirewallMiddleware } = await import('./api.node.ts')
      server.middlewares.use('/api/security/firewall', createSecurityFirewallMiddleware())
    },
    async configurePreviewServer(server) {
      const { createSecurityFirewallMiddleware } = await import('./api.node.ts')
      server.middlewares.use('/api/security/firewall', createSecurityFirewallMiddleware())
    },
  }
}
