import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as Tooltip from '@radix-ui/react-tooltip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DependencyProbeReport } from '@elysian/contracts'
import { UI_PREFERENCES_KEY, readMutedDependencyGuide } from '../../app/theme/themePreferences'
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
function gatewayWithProbe(
  probe: () => Promise<DependencyProbeReport>,
  setup: ElysianGateway['dependencies']['setup'] = async () => ({ ok: true, message: '已完成' }),
): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  return { ...base, dependencies: { probe, setup } }
}

async function renderDialogs(
  probe: () => Promise<DependencyProbeReport>,
  options: {
    scope?: 'docker-dependent' | 'websites'
    setup?: ElysianGateway['dependencies']['setup']
  } = {},
) {
  const scope = options.scope ?? 'websites'
  const reload = vi.fn()
  const gateway = gatewayWithProbe(probe, options.setup)
  const view = render(
    <GatewayProvider gateway={gateway}>
      <DependencyGuideDialogs scope={scope} reload={reload} />
    </GatewayProvider>,
    { wrapper: ({ children }) => <Tooltip.Provider>{children}</Tooltip.Provider> },
  )
  await act(async () => {
    await useDependencyGuideStore.getState().check(gateway)
  })
  return { reload, view, gateway }
}

beforeEach(() => {
  localStorage.removeItem(UI_PREFERENCES_KEY)
  useDependencyGuideStore.setState({
    report: undefined,
    status: 'idle',
    rechecking: false,
    dismissedDocker: false,
    dismissedCaddy: false,
    progress: {
      docker: { statuses: ['pending', 'pending', 'pending'], active: 0, failure: null },
      caddy: { statuses: ['pending', 'pending', 'pending', 'pending'], active: 0, failure: null },
    },
  })
  useNotificationStore.getState().clear()
})

afterEach(() => {
  localStorage.removeItem(UI_PREFERENCES_KEY)
  useDependencyGuideStore.setState({ dismissedDocker: false, dismissedCaddy: false })
})

describe('优先级组合（状态组合表）', () => {
  it('docker missing：Docker 弹窗渲染，含三步、分步安装说明与 detail', async () => {
    await renderDialogs(async () => DOCKER_MISSING)
    const dialog = screen.getByRole('dialog', { name: '安装 Docker' })
    expect(within(dialog).getAllByText('安装 Docker').length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText('开机自启').length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText('确认接通').length).toBeGreaterThan(0)
    expect(within(dialog).getByText(/官方安装脚本/)).toBeInTheDocument()
    expect(within(dialog).getByText(/开机即起/)).toBeInTheDocument()
    // 整窗说明不再常驻正文，收在标题右侧的问号里
    expect(dialog).not.toHaveTextContent(/分步代装/)
    await userEvent.click(within(dialog).getByRole('button', { name: '安装 Docker 说明' }))
    const help = await screen.findByRole('dialog', { name: '安装 Docker 说明' })
    expect(within(help).getByText(/分步代装/)).toBeInTheDocument()
    expect(within(help).getByText(/不会从头再装/)).toBeInTheDocument()
    expect(within(dialog).queryByText(/不会代你执行/)).toBeNull()
    expect(screen.getByText(/Docker 未安装或未接通/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '安装 Caddy' })).toBeNull()
    expect(screen.getByRole('button', { name: '关闭弹窗' })).not.toHaveFocus()
  })

  it('不再提示后弹窗关闭，重新探测也不再出现', async () => {
    const user = userEvent.setup()
    const { gateway } = await renderDialogs(async () => CADDY_MISSING)
    await user.click(screen.getByRole('button', { name: '不再提示' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(readMutedDependencyGuide(localStorage, 'caddy')).toBe(true)
    useDependencyGuideStore.setState({
      report: undefined,
      status: 'idle',
      dismissedDocker: readMutedDependencyGuide(localStorage, 'docker'),
      dismissedCaddy: readMutedDependencyGuide(localStorage, 'caddy'),
    })
    await act(async () => {
      await useDependencyGuideStore.getState().check(gateway)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
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
    expect(within(dialog).getAllByText('绑定管理通道').length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText('启动并常驻').length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText('确认通道').length).toBeGreaterThan(0)
    expect(within(dialog).getByText(/官方软件源/)).toBeInTheDocument()
    expect(within(dialog).getByText(/管理通道可连通/)).toBeInTheDocument()
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

describe('分步安装', () => {
  it('执行中按钮禁用；全部成功后弹窗消失、发成功通知且 reload 被调用一次', async () => {
    const user = userEvent.setup()
    let current: DependencyProbeReport = CADDY_MISSING
    let first = true
    let release: ((result: { ok: true; message: string }) => void) | undefined
    const setup = vi.fn(() => {
      if (first) {
        first = false
        return new Promise<{ ok: true; message: string }>((resolve) => {
          release = resolve
        })
      }
      return Promise.resolve({ ok: true as const, message: '已完成' })
    })
    const { reload } = await renderDialogs(() => Promise.resolve(current), { setup })
    await user.click(screen.getByRole('button', { name: '开始安装' }))
    const running = await screen.findByRole('button', { name: '正在执行…' })
    expect(running).toBeDisabled()
    current = ALL_OK
    release!({ ok: true, message: '已完成' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(useNotificationStore.getState().notifications.map((n) => n.message)).toContain('Caddy 管理通道已就绪')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('一步成功后滑到下一步，失败则停住且不执行后续步骤', async () => {
    const user = userEvent.setup()
    const scrolled: string[] = []
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      const stage = this.getAttribute('data-stage')
      if (stage) scrolled.push(stage)
    }
    const calls: string[] = []
    try {
      await renderDialogs(async () => CADDY_MISSING, {
        setup: async (_target, step) => {
          calls.push(step)
          if (step === 'configure') return { ok: false, message: 'Caddyfile 校验没有通过，已恢复原文件。' }
          return { ok: true, message: '已完成' }
        },
      })
      await user.click(screen.getByRole('button', { name: '开始安装' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Caddyfile 校验没有通过，已恢复原文件。')
      expect(useNotificationStore.getState().notifications).toEqual([expect.objectContaining({ tone: 'danger', message: 'Caddyfile 校验没有通过，已恢复原文件。' })])
      expect(calls).toEqual(['install', 'configure'])
      expect(scrolled).toEqual(['install', 'configure'])
      expect(screen.getByRole('button', { name: '重试' })).toBeEnabled()
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it('失败后关掉弹窗再重开，仍停在失败那一步，重试不重跑已成功的步骤', async () => {
    const user = userEvent.setup()
    const calls: string[] = []
    await renderDialogs(async () => CADDY_MISSING, {
      setup: async (_target, step) => {
        calls.push(step)
        if (step === 'configure') return { ok: false, message: 'Caddyfile 校验没有通过，已恢复原文件。' }
        return { ok: true, message: '已完成' }
      },
    })

    await user.click(screen.getByRole('button', { name: '开始安装' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Caddyfile 校验没有通过')
    expect(calls).toEqual(['install', 'configure'])

    await user.click(screen.getByRole('button', { name: '关闭弹窗' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    // 网站页工具栏的「安装 Caddy」重开：进度在 store 里，不随弹窗卸载而归零。
    act(() => useDependencyGuideStore.getState().reopenCaddy())
    const dialog = await screen.findByRole('dialog', { name: '安装 Caddy' })
    const steps = within(dialog).getByRole('list', { name: '安装步骤' })
    expect(within(steps).getByRole('button', { name: '安装 Caddy：已完成' })).toBeInTheDocument()
    expect(within(steps).getByRole('button', { name: '绑定管理通道：未完成' }).closest('li')).toHaveAttribute('aria-current', 'step')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Caddyfile 校验没有通过')

    await user.click(within(dialog).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(calls).toEqual(['install', 'configure', 'configure']))
  })

  it('docker 转就绪但 caddy 仍缺失：只发 Docker 通知，弹窗切换为 Caddy 引导（未关闭时）', async () => {
    const user = userEvent.setup()
    let current = DOCKER_MISSING
    const { reload } = await renderDialogs(async () => current)
    current = CADDY_MISSING
    await user.click(screen.getByRole('button', { name: '开始安装' }))
    expect(await screen.findByRole('dialog', { name: '安装 Caddy' })).toBeInTheDocument()
    const messages = useNotificationStore.getState().notifications.map((n) => n.message)
    expect(messages).toContain('Docker 已就绪')
    expect(messages).not.toContain('Caddy 管理通道已就绪')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('仍缺失时停留并刷新 detail，reload 不被调用', async () => {
    const user = userEvent.setup()
    let current = DOCKER_MISSING
    const { reload } = await renderDialogs(async () => current)
    current = DOCKER_ERROR_CADDY_MISSING
    await user.click(screen.getByRole('button', { name: '开始安装' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Docker Engine API 版本过低，需要 1.41 及以上')
    expect(screen.getByRole('dialog', { name: '安装 Docker' })).toBeInTheDocument()
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
    await user.click(screen.getByRole('button', { name: '开始安装' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('依赖检测失败')
    expect(screen.getByRole('dialog', { name: '安装 Docker' })).toBeInTheDocument()
    const notifications = useNotificationStore.getState().notifications
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ tone: 'danger', message: '依赖检测请求网络失败' })
    expect(reload).not.toHaveBeenCalled()
  })
})
