import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useGateway } from '../adapters/GatewayProvider'
import { ErrorState, LoadingState, NoPermissionState } from '../components/states/StateViews'
import type { PageArea } from '../contracts/adapters'
import { ShellPageFallback } from './layout/ShellLayoutContext'

/**
 * 页面级访问闸门。放在路由层，一处承载全部页面的无权限状态，
 * 不在每个页面里重复判断。
 *
 * 是否放行由 session 适配器决定；读取失败不等同于明确拒绝。
 */
export function RequireArea({
  area,
  title,
  children,
}: {
  area: PageArea
  title: string
  children: ReactNode
}) {
  const gateway = useGateway()
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{
    gateway: typeof gateway
    area: PageArea
    attempt: number
    allowed?: boolean
    error?: string
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const allowed = await gateway.session.canView(area)
        if (!cancelled) setResult({ gateway, area, attempt, allowed })
      } catch (error) {
        if (!cancelled) setResult({ gateway, area, attempt, error: error instanceof Error ? error.message : '暂时无法读取访问权限，请重试。' })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [gateway, area, attempt])

  // 校验期间只放加载态、不放页头：页面自己会渲染标题，
  // 这里再渲染一次会让标题节点在校验通过时被替换掉，测试与读屏都会抓到已失效的节点。
  const current = result?.gateway === gateway && result.area === area && result.attempt === attempt ? result : null
  if (!current) return <ShellPageFallback><LoadingState label="正在校验访问权限…" /></ShellPageFallback>

  if (current.error !== undefined) return <ShellPageFallback><ErrorState
    title="无法校验访问权限"
    description={current.error}
    onRetry={() => setAttempt(value => value + 1)}
  /></ShellPageFallback>

  if (!current.allowed) {
    return (
      <ShellPageFallback>
        <NoPermissionState
          title={`无权限查看「${title}」`}
          description="当前账号没有查看这部分内容的权限。"
        />
      </ShellPageFallback>
    )
  }

  return <>{children}</>
}
