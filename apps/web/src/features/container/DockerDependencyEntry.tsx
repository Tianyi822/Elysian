import { useGateway } from '../../adapters/GatewayProvider'
import { CTL_SECONDARY } from '../../components/formControl'
import { dockerInstallEntryVisible, useDependencyGuideStore } from '../../stores/dependencyGuideStore'

/**
 * Docker 页的常驻依赖入口：弹窗可关、可「不再提示」，但入口随探测报告常驻，
 * 与网站页「安装 Caddy」保持同一交互；探测失败时提供重新检测。
 */
export function DockerDependencyEntry({ className = '' }: { className?: string }) {
  const gateway = useGateway()
  const report = useDependencyGuideStore((s) => s.report)
  const status = useDependencyGuideStore((s) => s.status)
  const rechecking = useDependencyGuideStore((s) => s.rechecking)
  const recheck = useDependencyGuideStore((s) => s.recheck)
  const reopenDocker = useDependencyGuideStore((s) => s.reopenDocker)

  if (dockerInstallEntryVisible(report)) {
    return (
      <button type="button" className={`${CTL_SECONDARY} ${className}`.trim()} onClick={reopenDocker}>
        {report?.docker.state === 'error' ? '检查 Docker' : '安装 Docker'}
      </button>
    )
  }

  if (report !== undefined || status !== 'error') return null

  return (
    <button
      type="button"
      className={`${CTL_SECONDARY} ${className}`.trim()}
      disabled={rechecking}
      onClick={() => { void recheck(gateway).then(() => reopenDocker()) }}
    >
      {rechecking ? '正在检测 Docker…' : '重新检测 Docker'}
    </button>
  )
}
