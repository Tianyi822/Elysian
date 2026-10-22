import { useEffect, useRef } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { CTL_SECONDARY } from '../../components/formControl'
import { useDependencyProbeStore } from '../../stores/dependencyProbeStore'

/**
 * Docker 页的依赖重检入口：探测失败时提供「重新检测 Docker」，成功后报告由
 * 页面状态层与 Caddy 通道展示消费。
 */
export function DockerDependencyEntry({ className = '', onReady }: { className?: string; onReady: () => Promise<void> }) {
  const gateway = useGateway()
  const report = useDependencyProbeStore((s) => s.report)
  const status = useDependencyProbeStore((s) => s.status)
  const rechecking = useDependencyProbeStore((s) => s.rechecking)
  const recheck = useDependencyProbeStore((s) => s.recheck)
  const lifetime = useRef(0)
  useEffect(() => {
    lifetime.current += 1
    return () => { lifetime.current += 1 }
  }, [gateway])

  if (!rechecking && status !== 'error' && (report === undefined || report.docker.state === 'ok')) return null

  async function retry() {
    if (useDependencyProbeStore.getState().rechecking) return
    const current = lifetime.current
    const auth = captureAuthGeneration()
    const result = await recheck(gateway)
    if (current === lifetime.current && auth === captureAuthGeneration() && result?.docker.state === 'ok') await onReady()
  }

  return (
    <button
      type="button"
      className={`${CTL_SECONDARY} ${className}`.trim()}
      disabled={rechecking}
      onClick={() => { void retry() }}
    >
      {rechecking ? '正在检测 Docker…' : '重新检测 Docker'}
    </button>
  )
}
