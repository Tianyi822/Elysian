import { useEffect } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { useWebsitesStore } from '../../stores/websitesStore'
import { useDependencyGuideStore } from '../../stores/dependencyGuideStore'
import { DependencyGuideDialogs } from '../platform/DependencyGuideDialogs'
import { WebsitesPanel } from './WebsitesPanel'

/**
 * 网站部署区页面：单张卡片列表承载五种运行时类型（类型在创建时选择），
 * 点击卡片详情查看部署命令、流量与运行日志。数据经网站 adapter 提供：
 * Docker 运行时走同源 HTTP（容器、站点目录与宿主 Caddy 配置），
 * 宿主机本地开发走内存演示数据集。依赖引导层挂在三分支之外：Docker 未就绪时
 * 弹 Docker 引导（页面停在 ErrorState），Docker 就绪且 Caddy 缺失时弹 Caddy 引导
 * （列表照常、横幅呈现降级事实），与页面四状态机制互不侵入。
 */
export function WebsitesPage() {
  const gateway = useGateway()
  const status = useWebsitesStore((s) => s.status)
  const errorMessage = useWebsitesStore((s) => s.errorMessage)
  const load = useWebsitesStore((s) => s.load)
  const check = useDependencyGuideStore((s) => s.check)

  useEffect(() => {
    void load(gateway)
    // 依赖检测幂等：切页重挂不重探，报告由引导层消费。
    void check(gateway)
  }, [gateway, load, check])

  if (status === 'loading' || status === 'idle') {
    return (
      <>
        <LoadingState label="正在加载网站项目…" />
        <DependencyGuideDialogs scope="websites" reload={() => void load(gateway)} />
      </>
    )
  }

  if (status === 'error') {
    return (
      <>
        <ErrorState
          title="网站数据加载失败"
          description={errorMessage}
          onRetry={() => void load(gateway)}
        />
        {/* Docker 未就绪时网站片整片 503、页面停在错误态，弹窗叠加其上引导装 Docker。 */}
        <DependencyGuideDialogs scope="websites" reload={() => void load(gateway)} />
      </>
    )
  }

  return (
    <>
      <WebsitesPanel />
      <DependencyGuideDialogs scope="websites" reload={() => void load(gateway)} />
    </>
  )
}
