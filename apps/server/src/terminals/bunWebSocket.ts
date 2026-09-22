import { createBunWebSocket } from 'hono/bun'

/*
 * hono/bun WebSocket 适配器的进程级唯一实例。createBunWebSocket() 每进程必须恰好
 * 调用一次：upgradeWebSocket（路由侧升级入口）与 websocket（Bun.serve 的连接事件
 * 处理器）必须同源，多次调用会产出互不相识的两组处理器，升级后的连接无人接管。
 * index.ts（serve 的 websocket 字段）与 terminalsRoutes（/ws 升级）都从这里取，
 * 不许各自再调 createBunWebSocket。
 */
export const bunWebSocket = createBunWebSocket()
