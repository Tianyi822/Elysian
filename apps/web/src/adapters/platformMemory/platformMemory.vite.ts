import type { Plugin } from 'vite'

/** Vite 入口：Vitest 不加载本文件；dev/preview 动态挂载平台内存中间件。 */
export function elysianPlatformMemoryVitePlugin(): Plugin {
  return {
    name: 'elysian-platform-memory-api',
    async configureServer(server) {
      const { createPlatformMemoryMiddleware } = await import('./api.node.ts')
      server.middlewares.use('/api/platform/memory', createPlatformMemoryMiddleware())
    },
    async configurePreviewServer(server) {
      const { createPlatformMemoryMiddleware } = await import('./api.node.ts')
      server.middlewares.use('/api/platform/memory', createPlatformMemoryMiddleware())
    },
  }
}
