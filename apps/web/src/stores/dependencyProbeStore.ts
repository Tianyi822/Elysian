import type { DependencyProbeReport } from '@elysian/contracts'
import { create } from 'zustand'
import { captureAuthGeneration } from '../adapters/http/unauthorized'
import type { ElysianGateway } from '../contracts/adapters'
import { useMessageStore } from './messageStore'

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
  /** 返回本次报告；请求失败或所属网关、登录代次已失效时返回 null。 */
  recheck: (gateway: ElysianGateway) => Promise<DependencyProbeReport | null>
  reset: () => void
}

function notify(message: string, tone: 'success' | 'danger' = 'success'): void {
  useMessageStore.getState().notify({ message, tone })
}

/**
 * 网站页「访问配置」入口的可见性：Docker 与 Caddy 都就绪才开放，缺 Caddy 时不显示入口，
 * 而不是让人点进去再在保存处吃错误。随之一起关闭的还有改成 IP 直连、把域名项目切回直连
 * 这两条不依赖 Caddy 的路径——它们要等 Caddy 装好才可达。
 */
export function accessConfigEntryVisible(report: DependencyProbeReport | undefined, status: DependencyProbeStatus): boolean {
  return status === 'checked' && report !== undefined && report.docker.state === 'ok' && report.caddy.state === 'ok'
}

const initial = {
  report: undefined,
  status: 'idle' as const,
  rechecking: false,
}

export const useDependencyProbeStore = create<DependencyProbeStoreState>((set, get) => {
  // 导航复用同一请求；更换网关或登录后，旧请求不能回灌状态、通知或后续业务加载。
  let sequence = 0
  let owner: { gateway: ElysianGateway; auth: number } | undefined
  let pending: { manual: boolean; promise: Promise<DependencyProbeReport | null> } | undefined

  function probe(gateway: ElysianGateway, manual: boolean): Promise<DependencyProbeReport | null> {
    const auth = captureAuthGeneration()
    if (owner?.gateway !== gateway || owner.auth !== auth) {
      sequence += 1
      owner = { gateway, auth }
      pending = undefined
      set(initial)
    }
    if (pending) {
      if (manual) {
        pending.manual = true
        set({ rechecking: true })
      }
      return pending.promise
    }
    if (!manual && get().status === 'checked') return Promise.resolve(get().report ?? null)
    const previous = get().report
    const request = ++sequence
    const isCurrent = () => request === sequence && owner?.gateway === gateway && owner.auth === auth && auth === captureAuthGeneration()
    const operation = { manual, promise: Promise.resolve<DependencyProbeReport | null>(null) }
    pending = operation
    set({ status: 'checking', rechecking: manual })
    operation.promise = Promise.resolve().then(() => gateway.dependencies.probe()).then((report) => {
      if (!isCurrent()) return null
      set({ report, status: 'checked', rechecking: false })
      if (operation.manual && previous !== undefined) {
        if (previous.docker.state !== 'ok' && report.docker.state === 'ok') notify('Docker 已就绪')
        if (previous.caddy.state !== 'ok' && report.caddy.state === 'ok') notify('Caddy 管理通道已就绪')
      }
      return report
    }).catch((error: unknown) => {
      if (!isCurrent()) return null
      set({ status: 'error', rechecking: false })
      const message = error instanceof Error ? error.message : '依赖检测失败'
      notify(operation.manual ? message : `依赖检测失败：${message}`, 'danger')
      return null
    }).finally(() => {
      if (isCurrent() && pending === operation) pending = undefined
    })
    return operation.promise
  }

  return {
    ...initial,
    async check(gateway) { await probe(gateway, false) },
    recheck(gateway) { return probe(gateway, true) },
    reset() {
      sequence += 1
      owner = undefined
      pending = undefined
      set(initial)
    },
  }
})
