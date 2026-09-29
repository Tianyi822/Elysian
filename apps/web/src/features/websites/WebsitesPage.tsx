import { useEffect } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { useWebsitesStore } from '../../stores/websitesStore'
import { WebsitesPanel } from './WebsitesPanel'

/**
 * 网站部署区页面：单张卡片列表承载五种运行时类型（类型在创建时选择），
 * 点击卡片详情查看部署命令、流量与运行日志。数据经网站 adapter 提供：
 * Docker 运行时走同源 HTTP（容器、站点目录与宿主 Caddy 配置），
 * 宿主机本地开发走内存演示数据集。
 */
export function WebsitesPage() {
  const gateway = useGateway()
  const status = useWebsitesStore((s) => s.status)
  const errorMessage = useWebsitesStore((s) => s.errorMessage)
  const load = useWebsitesStore((s) => s.load)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  if (status === 'loading' || status === 'idle') {
    return <LoadingState label="正在加载网站项目…" />
  }

  if (status === 'error') {
    return (
      <ErrorState
        title="网站数据加载失败"
        description={errorMessage}
        onRetry={() => void load(gateway)}
      />
    )
  }

  return <WebsitesPanel />
}
