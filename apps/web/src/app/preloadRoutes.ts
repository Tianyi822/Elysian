import { importers } from './lazyRoutes'

/**
 * 登录后空闲预取仪表盘块：复用路由级分割的同一 importer，避免重复请求。
 * idle + 可见性双守卫由调用方（RequireSession）保证，这里只负责排程，
 * 不与当前页 chunk 争带宽。
 */
export function preloadDashboard() {
  const run = () => {
    void importers.dashboard()
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 })
  else setTimeout(run, 1200)
}
