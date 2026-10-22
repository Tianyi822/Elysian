import { useGateway } from '../../adapters/GatewayProvider'
import { CTL_SECONDARY } from '../../components/formControl'
import { useDependencyProbeStore } from '../../stores/dependencyProbeStore'

/**
 * Docker 页的依赖重检入口：探测失败时提供「重新检测 Docker」，成功后报告由
 * 页面状态层与 Caddy 通道展示消费。
 */
export function DockerDependencyEntry({ className = '' }: { className?: string }) {
  const gateway = useGateway()
  const report = useDependencyProbeStore((s) => s.report)
  const status = useDependencyProbeStore((s) => s.status)
  const rechecking = useDependencyProbeStore((s) => s.rechecking)
  const recheck = useDependencyProbeStore((s) => s.recheck)

  if (report !== undefined || status !== 'error') return null

  return (
    <button
      type="button"
      className={`${CTL_SECONDARY} ${className}`.trim()}
      disabled={rechecking}
      onClick={() => { void recheck(gateway) }}
    >
      {rechecking ? '正在检测 Docker…' : '重新检测 Docker'}
    </button>
  )
}
