import { describe, expect, it } from 'vitest'
import {
  DOCKER_MOUNT,
  FILES_MOUNT,
  FIREWALL_MOUNT,
  LOGS_MOUNT,
  SSH_MOUNT,
  TERMINAL_MOUNT,
  USERS_MOUNT,
} from '../../../../server/src/shared/apiMounts.ts'
import { SERVER_PORT } from '../../../../server/src/shared/ports.ts'
import config from '../../../vite.config'

/*
 * dev 与 preview 的同源代理表必须覆盖浏览器侧全部 HTTP 端点：容器内这些切片走
 * 「真实 HTTP adapter → vite 同源代理 → 容器内回环 server」，代理表缺项时请求会被
 * vite 的 SPA 回退吞成 index.html（响应不是 JSON，界面整片报「不是有效 JSON」而不可用）。
 * 这条接线既不在类型系统里、也不在组件测试里（没有组件会请求真实网络），只能在这里锚死：
 * 端点路径取 server 侧的挂载常量，新增切片忘记补代理时本用例立刻红。
 */

/** 浏览器经 HTTP adapter 直连的端点：安全三片、文件管理、容器、平台日志、终端 WebSocket 与平台内存。 */
const HTTP_ENDPOINTS: readonly { label: string; path: string }[] = [
  { label: '防火墙', path: `${FIREWALL_MOUNT}/rules` },
  { label: 'SSH', path: `${SSH_MOUNT}/overview` },
  { label: '主机用户', path: `${USERS_MOUNT}/list` },
  { label: '文件管理', path: `${FILES_MOUNT}/entries` },
  { label: '容器', path: `${DOCKER_MOUNT}/containers` },
  { label: '日志', path: `${LOGS_MOUNT}/runtime` },
  // 平台内存的挂载见 apps/server/src/app.ts:87（无导出常量，按字面量锚定）。
  { label: '平台内存', path: '/api/platform/memory' },
  { label: '终端', path: `${TERMINAL_MOUNT}/ws` },
]

/** 需要 WebSocket 代理（ws: true）的键：终端与容器管理。 */
const WS_PROXY_KEYS: readonly string[] = [TERMINAL_MOUNT, DOCKER_MOUNT]

/** 由本进程 elysianEventsVitePlugin 承载、绝不进代理表的端点。 */
const PLUGIN_ENDPOINTS: readonly string[] = ['/api/events', '/api/resources/history']

/** 代理表里是否有键覆盖该端点（键等于端点或为其路径前缀）。 */
function coveredBy(tableKeys: readonly string[], path: string): boolean {
  return tableKeys.some((key) => path === key || path.startsWith(`${key}/`))
}

describe('vite 同源代理表', () => {
  const tables = [
    { name: 'dev', proxy: config.server?.proxy ?? {} },
    { name: 'preview', proxy: config.preview?.proxy ?? {} },
  ] as const

  it.each(tables)('$name 覆盖全部浏览器侧端点前缀', ({ proxy }) => {
    const keys = Object.keys(proxy)
    const missing = HTTP_ENDPOINTS.filter((endpoint) => !coveredBy(keys, endpoint.path)).map(
      (endpoint) => `${endpoint.label}（${endpoint.path}）`,
    )
    expect(missing).toEqual([])
  })

  it.each(tables)('$name 的代理目标都是容器内回环的 server 端口，且保持对象形式（不改写 Host 头）', ({ proxy }) => {
    for (const [prefix, options] of Object.entries(proxy)) {
      expect({ prefix, target: (options as { target?: string }).target }).toEqual({
        prefix,
        target: `http://127.0.0.1:${SERVER_PORT}`,
      })
      // 字符串简写会强制 changeOrigin:true，改写 Host 头后同源守卫会 403 掉全部写请求
      expect({ prefix, changeOrigin: (options as { changeOrigin?: boolean }).changeOrigin }).toEqual({
        prefix,
        changeOrigin: undefined,
      })
    }
  })

  it.each(tables)('$name 不劫持本进程插件承载的事件流端点', ({ proxy }) => {
    const keys = Object.keys(proxy)
    const hijacked = PLUGIN_ENDPOINTS.filter((path) => coveredBy(keys, path))
    expect(hijacked).toEqual([])
  })

  it.each(tables)('$name 只对终端与容器键开 WebSocket 代理（ws: true）', ({ proxy }) => {
    for (const [prefix, options] of Object.entries(proxy)) {
      const ws = (options as { ws?: boolean }).ws
      if (WS_PROXY_KEYS.includes(prefix)) {
        // 终端是 WS 升级请求：不设 ws:true 时 vite 只按 HTTP 转发，升级握手被 SPA 回退吞掉。
        expect({ prefix, ws }).toEqual({ prefix, ws: true })
      } else {
        expect({ prefix, ws }).toEqual({ prefix, ws: undefined })
      }
    }
  })
})
