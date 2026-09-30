/** 供 tsc 解析 src/index.ts 的 Bun.serve；运行时由 Bun 提供，只声明本仓库用到的形状。 */
declare module 'bun' {
  export function serve(options: {
    hostname?: string
    port?: number
    /** HTTP 连接无字节流动的超时秒数（Bun 上限 255）：依赖安装一步最长 240 秒不回字节，缺省 10 秒会被掐断。 */
    idleTimeout?: number
    /** 第二参数是 Bun server 实例：hono/bun 的 upgradeWebSocket 从这里取实例完成升级。 */
    fetch: (request: Request, server?: object) => Response | Promise<Response>
    /** WebSocket 连接事件处理器（hono/bun 的 websocket handler）。 */
    websocket?: unknown
  }): { hostname: string; port: number }
}
