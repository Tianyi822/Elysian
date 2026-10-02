import type { DependencyProbeReport } from '@elysian/contracts'
import { create } from 'zustand'
import {
  readMutedDependencyGuide,
  writeMutedDependencyGuide,
  type DependencyGuideMuteKey,
} from '../app/theme/themePreferences'
import type { ElysianGateway } from '../contracts/adapters'
import { DEPENDENCY_GUIDE_CONTENT } from '../features/platform/dependencyGuideCopy'
import type { DependencyGuideKind } from '../features/platform/dependencyGuideCopy'
import { useNotificationStore } from './notificationStore'

/**
 * 依赖引导层的状态机：持有最近一份探测报告与两个会话内关闭标记，
 * 弹窗可见性是纯派生（下方两个选择器函数），组件只消费派生结果。
 * 端点报事实、前端编排优先级——Docker 未就绪时任何页面只弹 Docker 弹窗，
 * Caddy 弹窗以 Docker 就绪为前置且仅 missing 才引导（error 已装故障交状态层）。
 */

type DependencyGuideStatus = 'idle' | 'checking' | 'checked' | 'error'

/** 单个安装步骤在弹窗里的进度。 */
export type DependencyStageStatus = 'pending' | 'running' | 'done' | 'failed'

export type DependencyGuideProgress = {
  statuses: DependencyStageStatus[]
  /** 当前滑到第几步（步骤下标）。 */
  active: number
  failure: string | null
}

/**
 * 进度按依赖各自持有，存在 store 而不是弹窗组件里：弹窗关掉重开、切页再回来，
 * 仍停在失败或下一个未完成的那一步，不会归零回第 1 步重跑已成功的步骤。
 * 刷新页面回到全待办——面板的操作状态一律不落盘。
 */
function emptyProgress(kind: DependencyGuideKind): DependencyGuideProgress {
  return {
    statuses: DEPENDENCY_GUIDE_CONTENT[kind].stages.map(() => 'pending'),
    active: 0,
    failure: null,
  }
}

type DependencyGuideState = {
  report: DependencyProbeReport | undefined
  status: DependencyGuideStatus
  /** 「重新检测」按钮的忙碌态：动作进行中禁用并换文案。 */
  rechecking: boolean
  dismissedDocker: boolean
  dismissedCaddy: boolean
  progress: Record<DependencyGuideKind, DependencyGuideProgress>
  /** 页面挂载触发；checking / checked 时跳过（幂等），导航切页不重探。 */
  check: (gateway: ElysianGateway) => Promise<void>
  /**
   * 弹窗「重新检测」触发；强制重探，返回本次转就绪的依赖（becameReady），
   * 组件据此调页面的 reload 重入业务加载；无依赖转就绪时为 null。
   */
  recheck: (gateway: ElysianGateway) => Promise<'docker' | 'caddy' | null>
  /** 点关闭：只在本次打开期间不再弹，刷新后仍会按探测结果出现。 */
  dismissDocker: () => void
  dismissCaddy: () => void
  /** 点「不再提示」：写入界面偏好，刷新和再次进入页面都不再自动弹。 */
  muteGuide: (kind: DependencyGuideMuteKey) => void
  /** 网站页工具栏「安装 Caddy」的重开动作：清掉关闭标记和「不再提示」。 */
  reopenCaddy: () => void
  /** 弹窗写入某个依赖的步骤进度。 */
  patchProgress: (
    kind: DependencyGuideKind,
    patch: Partial<DependencyGuideProgress>,
  ) => void
}

function notify(message: string, tone: 'success' | 'danger' = 'success'): void {
  useNotificationStore.getState().notify({ message, tone })
}

/** 探测报某依赖已就绪时丢掉它的旧进度：下次再缺就从第 1 步开始，不带着上次的「已完成」。 */
function progressAfterProbe(
  previous: Record<DependencyGuideKind, DependencyGuideProgress>,
  report: DependencyProbeReport,
): Record<DependencyGuideKind, DependencyGuideProgress> {
  return {
    docker: report.docker.state === 'ok' ? emptyProgress('docker') : previous.docker,
    caddy: report.caddy.state === 'ok' ? emptyProgress('caddy') : previous.caddy,
  }
}

function readDismissed(): { dismissedDocker: boolean; dismissedCaddy: boolean } {
  try {
    return {
      dismissedDocker: readMutedDependencyGuide(localStorage, 'docker'),
      dismissedCaddy: readMutedDependencyGuide(localStorage, 'caddy'),
    }
  } catch {
    return { dismissedDocker: false, dismissedCaddy: false }
  }
}

function writeMuted(kind: DependencyGuideMuteKey, muted: boolean): void {
  try {
    writeMutedDependencyGuide(localStorage, kind, muted)
  } catch {
    // 偏好写不进去时仍关掉当前弹窗，至少这一次不再挡着操作。
  }
}

/** Docker 弹窗可见性：missing 与 error 都引导（三页都不可用，装官方新版对两种情形都成立）。 */
export function dockerGuideVisible(
  report: DependencyProbeReport | undefined,
  dismissed: boolean,
): boolean {
  return report !== undefined && report.docker.state !== 'ok' && !dismissed
}

/** Caddy 弹窗可见性：Docker 就绪是前置条件，只有 missing 才引导安装，error 交状态层横幅。 */
export function caddyGuideVisible(
  report: DependencyProbeReport | undefined,
  dismissed: boolean,
): boolean {
  return (
    report !== undefined &&
    report.docker.state === 'ok' &&
    report.caddy.state === 'missing' &&
    !dismissed
  )
}

/**
 * 网站页工具栏「安装 Caddy」重开入口的可见性：与弹窗关闭标记无关，
 * Docker 就绪且 Caddy 缺失期间常驻，装好（或降级为 error）即随报告消失。
 */
export function caddyInstallEntryVisible(report: DependencyProbeReport | undefined): boolean {
  return report !== undefined && report.docker.state === 'ok' && report.caddy.state === 'missing'
}

/**
 * 网站页「访问配置」入口的可见性：Docker 与 Caddy 都就绪才开放，缺 Caddy 时不显示入口，
 * 而不是让人点进去再在保存处吃错误。随之一起关闭的还有改成 IP 直连、把域名项目切回直连
 * 这两条不依赖 Caddy 的路径——它们要等 Caddy 装好才可达。
 */
export function accessConfigEntryVisible(report: DependencyProbeReport | undefined): boolean {
  return report !== undefined && report.docker.state === 'ok' && report.caddy.state === 'ok'
}

export const useDependencyGuideStore = create<DependencyGuideState>((set, get) => ({
  report: undefined,
  status: 'idle',
  rechecking: false,
  progress: { docker: emptyProgress('docker'), caddy: emptyProgress('caddy') },
  ...readDismissed(),

  async check(gateway) {
    if (get().status === 'checking' || get().status === 'checked') return
    set({ status: 'checking' })
    try {
      const report = await gateway.dependencies.probe()
      set({ report, status: 'checked', progress: progressAfterProbe(get().progress, report) })
    } catch {
      // 引导层静默失败：探测故障绝不伪装成依赖缺失，页面按既有业务态呈现。
      set({ status: 'error' })
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
      set({
        report,
        status: 'checked',
        rechecking: false,
        progress: progressAfterProbe(get().progress, report),
      })
      if (dockerBecameReady) notify(DEPENDENCY_GUIDE_CONTENT.docker.successNotice)
      if (caddyBecameReady) notify(DEPENDENCY_GUIDE_CONTENT.caddy.successNotice)
      // 两个同时转就绪时 Docker 优先：它就绪是 Caddy 维度出现的前提。
      return dockerBecameReady ? 'docker' : caddyBecameReady ? 'caddy' : null
    } catch (error) {
      // 重新检测是显式动作：失败要留下可见反馈，旧报告保留、弹窗不消失。
      set({ rechecking: false })
      notify(error instanceof Error ? error.message : '依赖检测失败', 'danger')
      return null
    }
  },

  dismissDocker() {
    set({ dismissedDocker: true })
  },

  dismissCaddy() {
    set({ dismissedCaddy: true })
  },

  muteGuide(kind) {
    writeMuted(kind, true)
    if (kind === 'docker') set({ dismissedDocker: true })
    else set({ dismissedCaddy: true })
  },

  reopenCaddy() {
    writeMuted('caddy', false)
    set({ dismissedCaddy: false })
  },

  patchProgress(kind, patch) {
    set((state) => ({
      progress: { ...state.progress, [kind]: { ...state.progress[kind], ...patch } },
    }))
  },
}))
