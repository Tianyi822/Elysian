import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DependencyProbeReport } from '@elysian/contracts'
import { readMutedDependencyGuide } from '../app/theme/themePreferences'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from './notificationStore'
import {
  caddyGuideVisible,
  caddyInstallEntryVisible,
  dockerGuideVisible,
  useDependencyGuideStore,
} from './dependencyGuideStore'

/*
 * 依赖引导 store 的行为测试。网关全部用手写 stub 注入（probe 可控、
 * 可拒绝），只依赖 adapter 接口形状；可见性选择器是纯函数，直接驱动。
 */

const DOCKER_MISSING: DependencyProbeReport = {
  docker: { state: 'missing', detail: 'Docker 未安装或未接通' },
  caddy: { state: 'missing', detail: '宿主未提供 Caddy 管理通道' },
}

const CADDY_MISSING: DependencyProbeReport = {
  docker: { state: 'ok', detail: null },
  caddy: { state: 'missing', detail: '宿主未提供 Caddy 管理通道' },
}

const ALL_OK: DependencyProbeReport = {
  docker: { state: 'ok', detail: null },
  caddy: { state: 'ok', detail: null },
}

function gatewayWith(probe: () => Promise<DependencyProbeReport>): ElysianGateway {
  const base = {
    probe,
  }
  // 只需要 dependencies 域：store 不触其它域，字面量其余成员以运行时不存在为准。
  return { dependencies: base } as unknown as ElysianGateway
}

const INITIAL_STATE = {
  report: undefined,
  status: 'idle' as const,
  rechecking: false,
  dismissedDocker: false,
  dismissedCaddy: false,
}

beforeEach(() => {
  useDependencyGuideStore.setState(INITIAL_STATE)
  useNotificationStore.getState().clear()
})

describe('check', () => {
  it('成功后落报告并置 checked', async () => {
    const gateway = gatewayWith(async () => DOCKER_MISSING)
    await useDependencyGuideStore.getState().check(gateway)
    const state = useDependencyGuideStore.getState()
    expect(state.status).toBe('checked')
    expect(state.report).toEqual(DOCKER_MISSING)
  })

  it('幂等：checked 后再 check 不再发请求', async () => {
    const probe = vi.fn(async () => ALL_OK)
    const gateway = gatewayWith(probe)
    await useDependencyGuideStore.getState().check(gateway)
    await useDependencyGuideStore.getState().check(gateway)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('checking 进行中时并发 check 不重复发请求', async () => {
    let release: (() => void) | undefined
    const probe = vi.fn(
      () =>
        new Promise<DependencyProbeReport>((resolve) => {
          release = () => resolve(ALL_OK)
        }),
    )
    const gateway = gatewayWith(probe)
    const first = useDependencyGuideStore.getState().check(gateway)
    const second = useDependencyGuideStore.getState().check(gateway)
    release?.()
    await Promise.all([first, second])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('抛错置 error、通知原因且 report 保持 undefined', async () => {
    const gateway = gatewayWith(() => Promise.reject(new Error('依赖检测请求网络失败')))
    await useDependencyGuideStore.getState().check(gateway)
    const state = useDependencyGuideStore.getState()
    expect(state.status).toBe('error')
    expect(state.report).toBeUndefined()
    expect(useNotificationStore.getState().notifications).toEqual([expect.objectContaining({ tone: 'danger', message: '依赖检测失败：依赖检测请求网络失败' })])
  })
})

describe('recheck', () => {
  it('checked 后仍强制重发并更新报告', async () => {
    let report = DOCKER_MISSING
    const probe = vi.fn(async () => report)
    const gateway = gatewayWith(probe)
    await useDependencyGuideStore.getState().check(gateway)
    report = { docker: { state: 'error', detail: 'Docker Engine API 版本过低，需要 1.41 及以上' }, caddy: DOCKER_MISSING.caddy }
    const becameReady = await useDependencyGuideStore.getState().recheck(gateway)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(useDependencyGuideStore.getState().report).toEqual(report)
    expect(becameReady).toBeNull()
  })

  it('docker 由缺失转就绪：becameReady 为 docker、发成功通知', async () => {
    let report = DOCKER_MISSING
    const gateway = gatewayWith(async () => report)
    await useDependencyGuideStore.getState().check(gateway)
    report = ALL_OK
    const becameReady = await useDependencyGuideStore.getState().recheck(gateway)
    expect(becameReady).toBe('docker')
    expect(useNotificationStore.getState().notifications.map((n) => n.message)).toContain('Docker 已就绪')
  })

  it('caddy 由缺失转就绪：becameReady 为 caddy、发对应通知', async () => {
    let report = CADDY_MISSING
    const gateway = gatewayWith(async () => report)
    await useDependencyGuideStore.getState().check(gateway)
    report = ALL_OK
    const becameReady = await useDependencyGuideStore.getState().recheck(gateway)
    expect(becameReady).toBe('caddy')
    expect(useNotificationStore.getState().notifications.map((n) => n.message)).toContain('Caddy 管理通道已就绪')
  })

  it('docker 转就绪但 caddy 仍缺失：只发 docker 通知，becameReady 为 docker', async () => {
    let report = DOCKER_MISSING
    const gateway = gatewayWith(async () => report)
    await useDependencyGuideStore.getState().check(gateway)
    report = CADDY_MISSING
    const becameReady = await useDependencyGuideStore.getState().recheck(gateway)
    expect(becameReady).toBe('docker')
    const messages = useNotificationStore.getState().notifications.map((n) => n.message)
    expect(messages).toContain('Docker 已就绪')
    expect(messages).not.toContain('Caddy 管理通道已就绪')
  })

  it('仍缺失时 becameReady 为 null 且不发成功通知', async () => {
    const gateway = gatewayWith(async () => DOCKER_MISSING)
    await useDependencyGuideStore.getState().check(gateway)
    const becameReady = await useDependencyGuideStore.getState().recheck(gateway)
    expect(becameReady).toBeNull()
    expect(useNotificationStore.getState().notifications).toHaveLength(0)
  })

  it('探测失败：旧报告保留、发危险通知、becameReady 为 null', async () => {
    let failing = false
    const gateway = gatewayWith(() =>
      failing ? Promise.reject(new Error('依赖检测请求网络失败')) : Promise.resolve(DOCKER_MISSING),
    )
    await useDependencyGuideStore.getState().check(gateway)
    failing = true
    const becameReady = await useDependencyGuideStore.getState().recheck(gateway)
    expect(becameReady).toBeNull()
    expect(useDependencyGuideStore.getState().report).toEqual(DOCKER_MISSING)
    expect(useDependencyGuideStore.getState().rechecking).toBe(false)
    const notifications = useNotificationStore.getState().notifications
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ tone: 'danger', message: '依赖检测请求网络失败' })
  })

  it('rechecking 在探测返回后回落', async () => {
    let release: (() => void) | undefined
    const gateway = gatewayWith(
      () =>
        new Promise<DependencyProbeReport>((resolve) => {
          release = () => resolve(ALL_OK)
        }),
    )
    const pending = useDependencyGuideStore.getState().recheck(gateway)
    expect(useDependencyGuideStore.getState().rechecking).toBe(true)
    release?.()
    await pending
    expect(useDependencyGuideStore.getState().rechecking).toBe(false)
  })
})

describe('dismiss 语义', () => {
  it('dismissDocker 只压掉 Docker 弹窗可见性', async () => {
    const gateway = gatewayWith(async () => DOCKER_MISSING)
    await useDependencyGuideStore.getState().check(gateway)
    useDependencyGuideStore.getState().dismissDocker()
    expect(dockerGuideVisible(useDependencyGuideStore.getState().report, useDependencyGuideStore.getState().dismissedDocker)).toBe(false)
    // Caddy 标记不受影响（虽然该报告下 Caddy 弹窗本就不可见）。
    expect(useDependencyGuideStore.getState().dismissedCaddy).toBe(false)
  })

  it('dismissCaddy 只压掉 Caddy 弹窗可见性', async () => {
    const gateway = gatewayWith(async () => CADDY_MISSING)
    await useDependencyGuideStore.getState().check(gateway)
    useDependencyGuideStore.getState().dismissCaddy()
    const state = useDependencyGuideStore.getState()
    expect(caddyGuideVisible(state.report, state.dismissedCaddy)).toBe(false)
    expect(state.dismissedDocker).toBe(false)
  })

  it('reopenCaddy 清掉 Caddy 关闭标记，弹窗重新可见', async () => {
    const gateway = gatewayWith(async () => CADDY_MISSING)
    await useDependencyGuideStore.getState().check(gateway)
    useDependencyGuideStore.getState().dismissCaddy()
    expect(caddyGuideVisible(useDependencyGuideStore.getState().report, useDependencyGuideStore.getState().dismissedCaddy)).toBe(false)
    useDependencyGuideStore.getState().reopenCaddy()
    const state = useDependencyGuideStore.getState()
    expect(caddyGuideVisible(state.report, state.dismissedCaddy)).toBe(true)
    expect(state.dismissedDocker).toBe(false)
  })

  it('不再提示写入偏好，重开安装入口时清掉', async () => {
    localStorage.clear()
    const gateway = gatewayWith(async () => CADDY_MISSING)
    await useDependencyGuideStore.getState().check(gateway)
    useDependencyGuideStore.getState().muteGuide('caddy')
    expect(readMutedDependencyGuide(localStorage, 'caddy')).toBe(true)
    expect(
      caddyGuideVisible(
        useDependencyGuideStore.getState().report,
        useDependencyGuideStore.getState().dismissedCaddy,
      ),
    ).toBe(false)
    useDependencyGuideStore.getState().reopenCaddy()
    expect(readMutedDependencyGuide(localStorage, 'caddy')).toBe(false)
    expect(
      caddyGuideVisible(
        useDependencyGuideStore.getState().report,
        useDependencyGuideStore.getState().dismissedCaddy,
      ),
    ).toBe(true)
    localStorage.clear()
  })
})

describe('优先级派生选择器', () => {
  it('report 未就绪（undefined）时两个弹窗都不可见', () => {
    expect(dockerGuideVisible(undefined, false)).toBe(false)
    expect(caddyGuideVisible(undefined, false)).toBe(false)
  })

  it('docker 非 ok 时 caddyGuideVisible 恒 false——即使 caddy 为 missing', () => {
    expect(caddyGuideVisible(DOCKER_MISSING, false)).toBe(false)
    const dockerError: DependencyProbeReport = {
      docker: { state: 'error', detail: 'Docker Engine API 版本过低，需要 1.41 及以上' },
      caddy: { state: 'missing', detail: '宿主未提供 Caddy 管理通道' },
    }
    expect(caddyGuideVisible(dockerError, false)).toBe(false)
  })

  it('docker ok + caddy missing 才弹 Caddy；caddy error 不弹（已装故障交状态层）', () => {
    expect(caddyGuideVisible(CADDY_MISSING, false)).toBe(true)
    const caddyError: DependencyProbeReport = {
      docker: { state: 'ok', detail: null },
      caddy: { state: 'error', detail: 'Caddy 引擎故障' },
    }
    expect(caddyGuideVisible(caddyError, false)).toBe(false)
  })

  it('docker missing 与 error 都弹 Docker 弹窗', () => {
    expect(dockerGuideVisible(DOCKER_MISSING, false)).toBe(true)
    const dockerError: DependencyProbeReport = {
      docker: { state: 'error', detail: 'Docker Engine API 版本过低，需要 1.41 及以上' },
      caddy: { state: 'ok', detail: null },
    }
    expect(dockerGuideVisible(dockerError, false)).toBe(true)
  })

  it('双 ok 时两个弹窗都不可见', () => {
    expect(dockerGuideVisible(ALL_OK, false)).toBe(false)
    expect(caddyGuideVisible(ALL_OK, false)).toBe(false)
  })
})

describe('网站页安装入口可见性', () => {
  it('docker ok 且 caddy missing 时入口可见，与关闭标记无关', () => {
    expect(caddyInstallEntryVisible(CADDY_MISSING)).toBe(true)
    expect(caddyInstallEntryVisible(undefined)).toBe(false)
    expect(caddyInstallEntryVisible(DOCKER_MISSING)).toBe(false)
    expect(caddyInstallEntryVisible(ALL_OK)).toBe(false)
    const caddyError: DependencyProbeReport = {
      docker: { state: 'ok', detail: null },
      caddy: { state: 'error', detail: 'Caddy 引擎故障' },
    }
    expect(caddyInstallEntryVisible(caddyError)).toBe(false)
  })
})
