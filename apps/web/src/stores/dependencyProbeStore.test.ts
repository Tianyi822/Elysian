import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DependencyProbeReport } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from './notificationStore'
import { accessConfigEntryVisible, useDependencyProbeStore } from './dependencyProbeStore'
import { advanceAuthGeneration } from '../adapters/http/unauthorized'

/*
 * 依赖探测 store 的行为测试。网关全部用手写 stub 注入（probe 可控、可拒绝），
 * 只依赖 adapter 接口形状；入口可见性选择器是纯函数，直接驱动。
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

beforeEach(() => {
  useDependencyProbeStore.getState().reset()
  useNotificationStore.getState().clear()
})

describe('check', () => {
  it('成功后落报告并置 checked', async () => {
    const gateway = gatewayWith(async () => DOCKER_MISSING)
    await useDependencyProbeStore.getState().check(gateway)
    const state = useDependencyProbeStore.getState()
    expect(state.status).toBe('checked')
    expect(state.report).toEqual(DOCKER_MISSING)
  })

  it('幂等：checked 后再 check 不再发请求', async () => {
    const probe = vi.fn(async () => ALL_OK)
    const gateway = gatewayWith(probe)
    await useDependencyProbeStore.getState().check(gateway)
    await useDependencyProbeStore.getState().check(gateway)
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
    const first = useDependencyProbeStore.getState().check(gateway)
    const second = useDependencyProbeStore.getState().check(gateway)
    await Promise.resolve()
    release?.()
    await Promise.all([first, second])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('抛错置 error、通知原因且 report 保持 undefined', async () => {
    const gateway = gatewayWith(() => Promise.reject(new Error('依赖检测请求网络失败')))
    await useDependencyProbeStore.getState().check(gateway)
    const state = useDependencyProbeStore.getState()
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
    await useDependencyProbeStore.getState().check(gateway)
    report = { docker: { state: 'error', detail: 'Docker Engine API 版本过低，需要 1.41 及以上' }, caddy: DOCKER_MISSING.caddy }
    const result = await useDependencyProbeStore.getState().recheck(gateway)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(useDependencyProbeStore.getState().report).toEqual(report)
    expect(result).toEqual(report)
  })

  it('docker 由缺失转就绪：返回报告、发成功通知', async () => {
    let report = DOCKER_MISSING
    const gateway = gatewayWith(async () => report)
    await useDependencyProbeStore.getState().check(gateway)
    report = ALL_OK
    const result = await useDependencyProbeStore.getState().recheck(gateway)
    expect(result).toEqual(ALL_OK)
    expect(useNotificationStore.getState().notifications.map((n) => n.message)).toContain('Docker 已就绪')
  })

  it('caddy 由缺失转就绪：返回报告、发对应通知', async () => {
    let report = CADDY_MISSING
    const gateway = gatewayWith(async () => report)
    await useDependencyProbeStore.getState().check(gateway)
    report = ALL_OK
    const result = await useDependencyProbeStore.getState().recheck(gateway)
    expect(result).toEqual(ALL_OK)
    expect(useNotificationStore.getState().notifications.map((n) => n.message)).toContain('Caddy 管理通道已就绪')
  })

  it('docker 转就绪但 caddy 仍缺失：返回完整报告，只发 docker 通知', async () => {
    let report = DOCKER_MISSING
    const gateway = gatewayWith(async () => report)
    await useDependencyProbeStore.getState().check(gateway)
    report = CADDY_MISSING
    const result = await useDependencyProbeStore.getState().recheck(gateway)
    expect(result).toEqual(CADDY_MISSING)
    const messages = useNotificationStore.getState().notifications.map((n) => n.message)
    expect(messages).toContain('Docker 已就绪')
    expect(messages).not.toContain('Caddy 管理通道已就绪')
  })

  it('仍缺失时返回报告且不发成功通知', async () => {
    const gateway = gatewayWith(async () => DOCKER_MISSING)
    await useDependencyProbeStore.getState().check(gateway)
    const result = await useDependencyProbeStore.getState().recheck(gateway)
    expect(result).toEqual(DOCKER_MISSING)
    expect(useNotificationStore.getState().notifications).toHaveLength(0)
  })

  it('探测失败：旧报告保留、状态失效、发危险通知、返回 null', async () => {
    let failing = false
    const gateway = gatewayWith(() =>
      failing ? Promise.reject(new Error('依赖检测请求网络失败')) : Promise.resolve(DOCKER_MISSING),
    )
    await useDependencyProbeStore.getState().check(gateway)
    failing = true
    const result = await useDependencyProbeStore.getState().recheck(gateway)
    expect(result).toBeNull()
    expect(useDependencyProbeStore.getState().report).toEqual(DOCKER_MISSING)
    expect(useDependencyProbeStore.getState().status).toBe('error')
    expect(useDependencyProbeStore.getState().rechecking).toBe(false)
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
    const pending = useDependencyProbeStore.getState().recheck(gateway)
    expect(useDependencyProbeStore.getState().rechecking).toBe(true)
    await Promise.resolve()
    release?.()
    await pending
    expect(useDependencyProbeStore.getState().rechecking).toBe(false)
  })

  it('首次恢复也返回完整报告，不需要旧报告已有 missing 状态', async () => {
    const gateway = gatewayWith(async () => ALL_OK)
    expect(await useDependencyProbeStore.getState().recheck(gateway)).toEqual(ALL_OK)
  })

  it('初次检查与手动重检共用一个在途请求，失败只通知一次', async () => {
    let reject: ((error: Error) => void) | undefined
    const probe = vi.fn(() => new Promise<DependencyProbeReport>((_resolve, fail) => { reject = fail }))
    const gateway = gatewayWith(probe)
    const initial = useDependencyProbeStore.getState().check(gateway)
    const manual = useDependencyProbeStore.getState().recheck(gateway)
    const duplicate = useDependencyProbeStore.getState().recheck(gateway)
    expect(manual).toBe(duplicate)
    await Promise.resolve()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(useDependencyProbeStore.getState().rechecking).toBe(true)
    reject?.(new Error('探测中断'))
    await Promise.all([initial, manual, duplicate])
    expect(useDependencyProbeStore.getState()).toMatchObject({ status: 'error', rechecking: false })
    expect(useNotificationStore.getState().notifications).toHaveLength(1)
  })

  it.each(['success', 'failure'] as const)('切换网关后旧请求 %s 不覆盖新请求忙碌或结果', async (outcome) => {
    let resolveOld: ((report: DependencyProbeReport) => void) | undefined
    let rejectOld: ((error: Error) => void) | undefined
    let resolveNew: ((report: DependencyProbeReport) => void) | undefined
    const oldGateway = gatewayWith(() => new Promise<DependencyProbeReport>((resolve, reject) => { resolveOld = resolve; rejectOld = reject }))
    const nextGateway = gatewayWith(() => new Promise<DependencyProbeReport>((resolve) => { resolveNew = resolve }))
    const old = useDependencyProbeStore.getState().recheck(oldGateway)
    await Promise.resolve()
    const next = useDependencyProbeStore.getState().recheck(nextGateway)
    await Promise.resolve()
    if (outcome === 'success') resolveOld?.(ALL_OK)
    else rejectOld?.(new Error('旧请求失败'))
    expect(await old).toBeNull()
    expect(useDependencyProbeStore.getState()).toMatchObject({ report: undefined, status: 'checking', rechecking: true })
    expect(useNotificationStore.getState().notifications).toHaveLength(0)
    resolveNew?.(CADDY_MISSING)
    expect(await next).toEqual(CADDY_MISSING)
    expect(useDependencyProbeStore.getState()).toMatchObject({ report: CADDY_MISSING, status: 'checked', rechecking: false })
  })

  it.each(['auth', 'reset'] as const)('%s 使旧响应失效，同一网关可以发起新探测', async (invalidation) => {
    let resolveOld: ((report: DependencyProbeReport) => void) | undefined
    const probe = vi.fn().mockImplementationOnce(() => new Promise<DependencyProbeReport>((resolve) => { resolveOld = resolve })).mockResolvedValue(CADDY_MISSING)
    const gateway = gatewayWith(probe)
    const old = useDependencyProbeStore.getState().recheck(gateway)
    await Promise.resolve()
    if (invalidation === 'auth') advanceAuthGeneration()
    else useDependencyProbeStore.getState().reset()
    await useDependencyProbeStore.getState().check(gateway)
    resolveOld?.(ALL_OK)
    expect(await old).toBeNull()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(useDependencyProbeStore.getState().report).toEqual(CADDY_MISSING)
    expect(useNotificationStore.getState().notifications).toHaveLength(0)
  })

  it('登录代次变化后不复用已经完成的 checked 报告', async () => {
    const probe = vi.fn().mockResolvedValueOnce(ALL_OK).mockResolvedValueOnce(CADDY_MISSING)
    const gateway = gatewayWith(probe)
    await useDependencyProbeStore.getState().check(gateway)
    advanceAuthGeneration()
    await useDependencyProbeStore.getState().check(gateway)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(useDependencyProbeStore.getState().report).toEqual(CADDY_MISSING)
  })
})

describe('网站页访问配置入口可见性', () => {
  it('docker 与 caddy 都就绪才可见，任一缺失、故障或报告缺失时不可见', () => {
    expect(accessConfigEntryVisible(ALL_OK, 'checked')).toBe(true)
    expect(accessConfigEntryVisible(undefined, 'checked')).toBe(false)
    expect(accessConfigEntryVisible(DOCKER_MISSING, 'checked')).toBe(false)
    expect(accessConfigEntryVisible(CADDY_MISSING, 'checked')).toBe(false)
    expect(accessConfigEntryVisible(ALL_OK, 'error')).toBe(false)
    expect(accessConfigEntryVisible(ALL_OK, 'checking')).toBe(false)
    const caddyError: DependencyProbeReport = {
      docker: { state: 'ok', detail: null },
      caddy: { state: 'error', detail: 'Caddy 引擎故障' },
    }
    expect(accessConfigEntryVisible(caddyError, 'checked')).toBe(false)
  })
})
