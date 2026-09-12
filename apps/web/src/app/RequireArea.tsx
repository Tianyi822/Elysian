import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useGateway } from '../adapters/GatewayProvider'
import { PageHeader } from '../components/PageHeader'
import { LoadingState, NoPermissionState } from '../components/states/StateViews'
import type { PageArea } from '../contracts/adapters'

/**
 * 页面级访问闸门。放在路由层，一处承载全部页面的无权限状态，
 * 不在每个页面里重复判断。
 *
 * 本期没有认证，会话适配器默认全部放行；但这条分支是真实存在的：
 * 接上认证与策略后，是否放行由 session 适配器决定，页面本身不用改。
 */
export function RequireArea({
  area,
  title,
  description,
  children,
}: {
  area: PageArea
  title: string
  description?: string
  children: ReactNode
}) {
  const gateway = useGateway()
  const [allowed, setAllowed] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setAllowed(undefined)

    void (async () => {
      try {
        const result = await gateway.session.canView(area)
        if (!cancelled) setAllowed(result)
      } catch {
        // 判定不了就按无权限处理：权限出错时宁可挡住，也不要放行。
        if (!cancelled) setAllowed(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [gateway, area])

  // 校验期间只放加载态、不放页头：页面自己会渲染标题，
  // 这里再渲染一次会让标题节点在校验通过时被替换掉，测试与读屏都会抓到已失效的节点。
  if (allowed === undefined) return <LoadingState label="正在校验访问权限…" />

  if (!allowed) {
    return (
      <>
        <PageHeader title={title} description={description} />
        <NoPermissionState
          description={`当前账号没有查看「${title}」的权限。本阶段的权限只是接口占位，接入认证后由服务端判定。`}
        />
      </>
    )
  }

  return <>{children}</>
}
