import type { DependencyProbeReport } from '@elysian/contracts'
import { create } from 'zustand'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from './notificationStore'

/**
 * 依赖探测层的状态机：持有最近一份探测报告，供容器页、数据库页、网站页与
 * Caddy 通道状态展示消费。端点报事实、前端按 Docker 优先于 Caddy 的次序发
 * 转就绪通知（Docker 就绪是 Caddy 维度出现的前提）。
 */

type DependencyProbeStatus = 'idle' | 'checking' | 'checked' | 'error'

type DependencyProbeStoreState = {
  report: DependencyProbeReport | undefined
  status: DependencyProbeStatus
  /** 「重新检测」按钮的忙碌态：动作进行中禁用并换文案。 */
  rechecking: boolean
  /** 页面挂载触发；checking / checked 时跳过（幂等），导航切页不重探。 */
  check: (gateway: ElysianGateway) => Promise<void>
  /**
   * 「重新检测」触发；强制重探，返回本次转就绪的依赖（becameReady），
   * 组件据此调页面的 reload 重入业务加载；无依赖转就绪时为 null。
   */
  recheck: (gateway: ElysianGateway) => Promise<'docker' | 'caddy' | null>
}

function notify(message: string, tone: 'success' | 'danger' = 'success'): void {
  useNotificationStore.getState().notify({ message, tone })
}

/**
 * 网站页「访问配置」入口的可见性：Docker 与 Caddy 都就绪才开放，缺 Caddy 时不显示入口，
 * 而不是让人点进去再在保存处吃错误。随之一起关闭的还有改成 IP 直连、把域名项目切回直连
 * 这两条不依赖 Caddy 的路径——它们要等 Caddy 装好才可达。
 */
export function accessConfigEntryVisible(report: DependencyProbeReport | undefined): boolean {
  return report !== undefined && report.docker.state === 'ok' && report.caddy.state === 'ok'
}

export const useDependencyProbeStore = create<DependencyProbeStoreState>((set, get) => ({
  report: undefined,
  status: 'idle',
  rechecking: false,

  async check(gateway) {
    if (get().status === 'checking' || get().status === 'checked') return
    set({ status: 'checking' })
    try {
      const report = await gateway.dependencies.probe()
      set({ report, status: 'checked' })
    } catch (error) {
      set({ status: 'error' })
      notify(error instanceof Error ? `依赖检测失败：${error.message}` : '依赖检测失败', 'danger')
    }
  },

  async recheck(gateway) {
    const previous = get().report
    set({ rechecking: true })
    try {
      const report = await gateway.dependencies.probe()
      const dockerBecameReady =
        previous !== undefined && previous.docker.state !== 'ok' && report.docker.state === 'ok'
      const caddyBecameReady =
        previous !== undefined && previous.caddy.state !== 'ok' && report.caddy.state === 'ok'
      set({ report, status: 'checked', rechecking: false })
      if (dockerBecameReady) notify('Docker 已就绪')
      if (caddyBecameReady) notify('Caddy 管理通道已就绪')
      // 两个同时转就绪时 Docker 优先：它就绪是 Caddy 维度出现的前提。
      return dockerBecameReady ? 'docker' : caddyBecameReady ? 'caddy' : null
    } catch (error) {
      // 重新检测是显式动作：失败要留下可见反馈，旧报告保留。
      set({ rechecking: false })
      notify(error instanceof Error ? error.message : '依赖检测失败', 'danger')
      return null
    }
  },
}))
