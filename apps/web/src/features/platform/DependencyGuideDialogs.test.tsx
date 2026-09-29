import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DependencyProbeReport } from '@elysian/contracts'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway } from '../../contracts/adapters'
import { useDependencyGuideStore } from '../../stores/dependencyGuideStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { DependencyGuideDialogs } from './DependencyGuideDialogs'

/*
 * 依赖引导层的组件测试：注入可控 probe 的网关，覆盖优先级组合（状态组合表）、
 * 关闭语义（会话内不重弹）、「重新检测」的 pending / 转就绪交接与静默失败。
 */

const DOCKER_MISSING: DependencyProbeReport = {
  docker: { state: 'missing', detail: 'Docker 未安装或未接通' },
  caddy: { state: 'missing', detail: '宿主未提供 Caddy 管理通道' },
}

const DOCKER_ERROR_CADDY_MISSING: DependencyProbeReport = {
  docker: { state: 'error', detail: 'Docker Engine API 版本过低，需要 1.41 及以上' },
  caddy: { state: 'missing', detail: '宿主未提供 Caddy 管理通道' },
}

const DOCKER_ERROR: DependencyProbeReport = {
  docker: { state: 'error', detail: 'Docker Engine API 版本过低，需要 1.41 及以上' },
  caddy: { state: 'ok', detail: null },
}

const CADDY_MISSING: DependencyProbeReport = {
  docker: { state: 'ok', detail: null },
  caddy: { state: 'missing', detail: '宿主未提供 Caddy 管理通道' },
}

const CADDY_ERROR: DependencyProbeReport = {
  docker: { state: 'ok', detail: null },
  caddy: { state: 'error', detail: 'Caddy 请求超时' },
}

const ALL_OK: DependencyProbeReport = {
  docker: { state: 'ok', detail: null },
  caddy: { state: 'ok', detail: null },
}

/** 可控探测网关：report 变量在用例内翻转即可模拟「缺失 → 接通」。 */
function gatewayWithProbe(probe: () => Promise<DependencyProbeReport>): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  return { ...base, dependencies: { probe } }
}

async function renderDialogs(
  probe: () => Promise<DependencyProbeReport>,
  options: { scope?: 'docker-dependent' | 'websites' } = {},
) {
  const scope = options.scope ?? 'websites'
  const reload = vi.fn()
  const gateway = gatewayWithProbe(probe)
  const view = render(
    <GatewayProvider gateway={gateway}>
      <DependencyGuideDialogs scope={scope} reload={reload} />
    </GatewayProvider>,
  )
  await act(async () => {
    await useDependencyGuideStore.getState().check(gateway)
  })
  return { reload, view, gateway }
}

beforeEach(() => {
  useDependencyGuideStore.setState({
    report: undefined,
    status: 'idle',
    rechecking: false,
    dismissedDocker: false,
    dismissedCaddy: false,
  })
  useNotificationStore.getState().clear()
})

describe('优先级组合（状态组合表）', () => {
  it('docker missing：Docker 弹窗渲染，含标题、四条步骤、不代装声明与 detail 次要文字', async () => {
    await renderDialogs(async () => DOCKER_MISSING)
    const dialog = screen.getByRole('dialog', { name: '安装 Docker' })
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(4)
    expect(screen.getByText(/面板不会代你执行任何安装命令/)).toBeInTheDocument()
    expect(screen.getByText(/Docker 未安装或未接通/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '安装 Caddy' })).toBeNull()
  })

  it('docker error（版本过低）：Docker 弹窗仍渲染且 detail 为引擎原因', async () => {
    await renderDialogs(async () => DOCKER_ERROR)
    const dialog = screen.getByRole('dialog', { name: '安装 Docker' })
    expect(within(dialog).getByText(/Docker Engine API 版本过低，需要 1.41 及以上/)).toBeInTheDocument()
  })

  it('docker ok + caddy missing + scope docker-dependent：无 Caddy 弹窗（容器/数据库页无 Caddy 维度）', async () => {
    await renderDialogs(async () => CADDY_MISSING, { scope: 'docker-dependent' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('docker ok + caddy missing + scope websites：Caddy 弹窗渲染', async () => {
    await renderDialogs(async () => CADDY_MISSING)
    const dialog = screen.getByRole('dialog', { name: '安装 Caddy' })
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(4)
    expect(screen.getByText(/宿主未提供 Caddy 管理通道/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '安装 Docker' })).toBeNull()
  })

  it('docker 非 ok + caddy missing + scope websites：只有 Docker 弹窗（Docker 高于 Caddy）', async () => {
    await renderDialogs(async () => DOCKER_MISSING)
    expect(screen.getByRole('dialog', { name: '安装 Docker' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '安装 Caddy' })).toBeNull()
  })

  it('docker ok + caddy error + scope websites：无弹窗（已装故障交横幅状态层）', async () => {
    await renderDialogs(async () => CADDY_ERROR)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('双 ok：无弹窗', async () => {
    await renderDialogs(async () => ALL_OK)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('检测请求失败：不渲染弹窗（静默失败，不伪装成依赖缺失）', async () => {
    const { reload } = await renderDialogs(() => Promise.reject(new Error('依赖检测请求网络失败')))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('关闭语义（会话内不重弹）', () => {
  it('Esc 关闭后会话内不重弹（重渲染仍不出现）', async () => {
    const { view } = await renderDialogs(async () => CADDY_MISSING)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    // 同一会话内组件重渲染（页面切回）不复活弹窗。
    view.rerender(
      <GatewayProvider gateway={gatewayWithProbe(async () => CADDY_MISSING)}>
        <DependencyGuideDialogs scope="websites" reload={() => {}} />
      </GatewayProvider>,
    )
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('关闭按钮关闭后会话内不重弹', async () => {
    const user = userEvent.setup()
    await renderDialogs(async () => DOCKER_MISSING)
    await user.click(screen.getByRole('button', { name: '关闭弹窗' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('重新检测', () => {
  it('pending 时按钮禁用并显示「正在检测…」，转 ok 后弹窗消失、发成功通知且 reload 被调用一次', async () => {
    const user = userEvent.setup()
    let current: DependencyProbeReport = CADDY_MISSING
    let pending: Promise<DependencyProbeReport> | null = null
    let release: ((report: DependencyProbeReport) => void) | undefined
    const { reload } = await renderDialogs(() => pending ?? Promise.resolve(current))
    // 首次 check 已消费 CADDY_MISSING；点「重新检测」前把探测换挂起的 promise。
    pending = new Promise<DependencyProbeReport>((resolve) => {
      release = (report) => resolve(report)
    })
    await user.click(screen.getByRole('button', { name: '重新检测' }))
    const checking = screen.getByRole('button', { name: '正在检测…' })
    expect(checking).toBeDisabled()
    release!(ALL_OK)
    current = ALL_OK
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useNotificationStore.getState().notifications.map((n) => n.message)).toContain('Caddy 管理通道已就绪')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('docker 转就绪但 caddy 仍缺失：只发 Docker 通知，弹窗切换为 Caddy 引导（未关闭时）', async () => {
    const user = userEvent.setup()
    let current = DOCKER_MISSING
    const { reload } = await renderDialogs(async () => current)
    current = CADDY_MISSING
    await user.click(screen.getByRole('button', { name: '重新检测' }))
    await act(async () => {})
    const messages = useNotificationStore.getState().notifications.map((n) => n.message)
    expect(messages).toContain('Docker 已就绪')
    expect(messages).not.toContain('Caddy 管理通道已就绪')
    expect(reload).toHaveBeenCalledTimes(1)
    // Docker 就绪后 Caddy 维度出现：网站页同一报告下 Caddy 弹窗接续引导。
    expect(screen.getByRole('dialog', { name: '安装 Caddy' })).toBeInTheDocument()
  })

  it('仍缺失时停留并刷新 detail，reload 不被调用', async () => {
    const user = userEvent.setup()
    let current = DOCKER_MISSING
    const { reload } = await renderDialogs(async () => current)
    // 只变 docker 的状态与 detail（missing → error），caddy 保持缺失。
    current = DOCKER_ERROR_CADDY_MISSING
    await user.click(screen.getByRole('button', { name: '重新检测' }))
    await act(async () => {})
    expect(screen.getByRole('dialog', { name: '安装 Docker' })).toBeInTheDocument()
    expect(screen.getByText(/Docker Engine API 版本过低，需要 1.41 及以上/)).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
  })

  it('探测请求失败：弹窗保留、发危险通知、reload 不被调用', async () => {
    const user = userEvent.setup()
    let current: DependencyProbeReport = DOCKER_MISSING
    let failing = false
    const probe = () => (failing ? Promise.reject(new Error('依赖检测请求网络失败')) : Promise.resolve(current))
    const { reload } = await renderDialogs(probe)
    failing = true
    current = ALL_OK
    await user.click(screen.getByRole('button', { name: '重新检测' }))
    await act(async () => {})
    expect(screen.getByRole('dialog', { name: '安装 Docker' })).toBeInTheDocument()
    const notifications = useNotificationStore.getState().notifications
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ tone: 'danger', message: '依赖检测请求网络失败' })
    expect(reload).not.toHaveBeenCalled()
  })
})
