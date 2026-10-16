import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { useGateway } from '../adapters/GatewayProvider'
import { ErrorState, LoadingState } from '../components/states/StateViews'
import { useSessionStore } from '../stores/sessionStore'
import { NotificationHost } from '../components/NotificationHost'

/**
 * 会话闸门：包住 AppShell 路由，未登录（真实会话模式）一律重定向 /login 并记住
 * 来源路径，登录成功后回跳。演示模式（本地无后端）永不重定向；探测请求本身失败
 * 渲染错误态与重试，不让页面停在无限加载。
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const gateway = useGateway()
  const location = useLocation()
  const phase = useSessionStore((state) => state.phase)
  const mode = useSessionStore((state) => state.mode)
  const probe = useSessionStore((state) => state.probe)
  const revalidate = useSessionStore((state) => state.revalidate)

  useEffect(() => {
    void probe(gateway)
  }, [probe, gateway])

  useEffect(() => {
    if (phase !== 'authed' || mode !== 'real') return
    let pending = false
    const check = () => {
      if (document.visibilityState === 'hidden' || pending) return
      pending = true
      void revalidate(gateway).finally(() => { pending = false })
    }
    // 静止页面也能感知新登录；切回后台标签页或恢复网络时立即确认。
    const timer = window.setInterval(check, 15_000)
    window.addEventListener('focus', check)
    window.addEventListener('online', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', check)
      window.removeEventListener('online', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [phase, mode, revalidate, gateway])

  if (phase === 'unknown') {
    return <LoadingState label="正在检查登录状态…" />
  }

  if (phase === 'error') {
    return (
      <><ErrorState
        title="登录状态检查失败"
        description="无法连接面板服务，请确认服务已启动。"
        onRetry={() => void probe(gateway)}
      /><NotificationHost /></>
    )
  }

  if (phase === 'anonymous' && mode === 'real') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  return <>{children}</>
}
