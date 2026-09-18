import type { Plugin } from 'vite'

/** Vite 入口：Vitest 不加载本文件；dev/preview 动态挂载 Node 中间件。 */
export function elysianEventsVitePlugin(): Plugin {
  return {
    name: 'elysian-mock-events',
    async configureServer(server) {
      const { createElysianDevMiddlewares } = await import('./mockEventsPlugin.node.ts')
      const { eventsHandler, historyHandler } = createElysianDevMiddlewares()
      server.middlewares.use('/api/events', eventsHandler)
      server.middlewares.use('/api/resources/history', historyHandler)
    },
    async configurePreviewServer(server) {
      const { createElysianDevMiddlewares } = await import('./mockEventsPlugin.node.ts')
      const { eventsHandler, historyHandler } = createElysianDevMiddlewares()
      server.middlewares.use('/api/events', eventsHandler)
      server.middlewares.use('/api/resources/history', historyHandler)
    },
  }
}
