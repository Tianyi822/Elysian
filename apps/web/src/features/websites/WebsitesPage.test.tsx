import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DependencyProbeReport } from '@elysian/contracts'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { resetWebsitesData } from '../../adapters/mock/websitesData'
import { useDependencyGuideStore } from '../../stores/dependencyGuideStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { useWebsitesStore } from '../../stores/websitesStore'
import { renderApp } from '../../test/renderApp'

/*
 * 网站页页面级测试：依赖引导层与页面四状态的并存与交接。mock 网关依赖恒 ok
 * 时各状态无弹窗（四状态不回归）；注入 docker missing 时错误态叠加 Docker 弹窗
 * （状态组合表「docker 非 ok」行）；「重新检测」转就绪后经 reload 重入页面 load，
 * 页面从错误态恢复列表。
 */

const DOCKER_MISSING: DependencyProbeReport = {
  docker: { state: 'missing', detail: 'Docker 未安装或未接通' },
  caddy: { state: 'missing', detail: '宿主未提供 Caddy 管理通道' },
}

const ALL_OK: DependencyProbeReport = {
  docker: { state: 'ok', detail: null },
  caddy: { state: 'ok', detail: null },
}

function pageGateway(options: {
  dependencies?: () => Promise<DependencyProbeReport>
  listFailing?: () => boolean
} = {}): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const websites = base.websites
  const listFailing = options.listFailing ?? (() => false)
  return {
    ...base,
    dependencies: {
      probe: options.dependencies ?? (() => base.dependencies.probe()),
    },
    // 适配器方法在原型上，展开会丢；显式委托再叠加覆盖项。
    websites: {
      list: async () => {
        if (listFailing()) throw new Error('网站数据不可用')
        return websites.list()
      },
      create: (kind, input) => websites.create(kind, input),
      update: (projectId, input) => websites.update(projectId, input),
      remove: (projectId) => websites.remove(projectId),
      setRunning: (projectId, running) => websites.setRunning(projectId, running),
      logs: (projectId) => websites.logs(projectId),
      reconcileProxy: () => websites.reconcileProxy(),
    },
  }
}

beforeEach(() => {
  resetWebsitesData()
  useNotificationStore.getState().clear()
  useWebsitesStore.setState({
    status: 'idle',
    errorMessage: undefined,
    projects: [],
    proxyStatus: { state: 'active', detail: null },
    search: '',
    category: 'all',
    refreshing: false,
    reconciling: false,
    saving: false,
    createDialogOpen: false,
    settingsTarget: undefined,
    removeTarget: undefined,
    detailTarget: undefined,
    detailLogs: undefined,
    detailLogsLoading: false,
    busyProjectIds: [],
  })
  useDependencyGuideStore.setState({
    report: undefined,
    status: 'idle',
    rechecking: false,
    dismissedDocker: false,
    dismissedCaddy: false,
  })
})

describe('网站页与依赖引导层', () => {
  it('mock 网关依赖恒 ok：成功态与错误态都不出现安装引导弹窗', async () => {
    let failing = true
    const gateway = pageGateway({ listFailing: () => failing })
    renderApp('/websites', { gateway })
    expect(await screen.findByRole('alert')).toHaveTextContent('网站数据不可用')
    expect(screen.queryByRole('dialog')).toBeNull()
    failing = false
    const user = userEvent.setup()
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('list', { name: '网站项目列表' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('docker missing 时错误态叠加 Docker 弹窗，容器页维度的 Caddy 弹窗不出现', async () => {
    const gateway = pageGateway({
      dependencies: async () => DOCKER_MISSING,
      listFailing: () => true,
    })
    renderApp('/websites', { gateway })
    // 弹窗打开时 Radix 会把应用根标 aria-hidden，错误态用文本断言而非 role 查询。
    expect(await screen.findByText('网站数据不可用')).toBeInTheDocument()
    const dialog = screen.getByRole('dialog', { name: '安装 Docker' })
    expect(within(dialog).getByText(/Docker 未安装或未接通/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '安装 Caddy' })).toBeNull()
  })

  it('「重新检测」转就绪后弹窗消失、发成功通知并经 reload 重入页面加载', async () => {
    let report = DOCKER_MISSING
    let failing = true
    const gateway = pageGateway({
      dependencies: async () => report,
      listFailing: () => failing,
    })
    renderApp('/websites', { gateway })
    expect(await screen.findByRole('dialog', { name: '安装 Docker' })).toBeInTheDocument()
    // 依赖接通：面板容器也恢复服务，页面应从错误态回到列表，无须手动点重试。
    report = ALL_OK
    failing = false
    const user = userEvent.setup()
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '重新检测' }))
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useNotificationStore.getState().notifications.map((n) => n.message)).toContain('Docker 已就绪')
    expect(await screen.findByRole('list', { name: '网站项目列表' })).toBeInTheDocument()
  })

  it('docker 就绪且 caddy missing：列表照常渲染、Caddy 弹窗叠加（横幅之外引导安装）', async () => {
    const gateway = pageGateway({
      dependencies: async () => ({
        docker: { state: 'ok', detail: null },
        caddy: { state: 'missing', detail: '宿主未提供 Caddy 管理通道' },
      }),
    })
    renderApp('/websites', { gateway })
    expect(await screen.findByRole('list', { name: '网站项目列表' })).toBeInTheDocument()
    const dialog = screen.getByRole('dialog', { name: '安装 Caddy' })
    expect(within(dialog).getByText(/宿主未提供 Caddy 管理通道/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '安装 Docker' })).toBeNull()
  })

  it('关闭 Caddy 弹窗后会话内不重弹，页面列表保持可用', async () => {
    const gateway = pageGateway({
      dependencies: async () => ({
        docker: { state: 'ok', detail: null },
        caddy: { state: 'missing', detail: '宿主未提供 Caddy 管理通道' },
      }),
    })
    renderApp('/websites', { gateway })
    await screen.findByRole('list', { name: '网站项目列表' })
    const user = userEvent.setup()
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭弹窗' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('list', { name: '网站项目列表' })).toBeInTheDocument()
  })
})
