import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Container, ContainerCreateInput, ContainerImage } from '@elysian/contracts'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { CONTAINERS } from '../../adapters/mock/containersData'
import { resolveViewTab, writeStoredViewTab } from '../../app/theme/themePreferences'
import { useContainersStore } from '../../stores/containersStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { renderApp } from '../../test/renderApp'

/**
 * 页面测试网关：内存事件源 + 慢节拍，动作类接口按需覆盖。
 * 事件流取 createMockGateway 的内存实现（一分钟一拍），
 * 只替换 containers 域——AppShell 挂载时就会订阅事件流，缺 events 会让整树崩溃。
 */
function pageGateway(overrides: Partial<ElysianGateway['containers']> = {}): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const containers = Object.assign(
    {
      list: async () => [...CONTAINERS],
      // listImages 直通真实 mock 数据集：删除镜像要落实到数据集，读种子常量会绕过它。
      listImages: () => base.containers.listImages(),
      searchImageNames: (term: string, registry?: string, signal?: AbortSignal) =>
        base.containers.searchImageNames(term, registry, signal),
      imageTags: (name: string, registry?: string, signal?: AbortSignal) =>
        base.containers.imageTags(name, registry, signal),
      createPolicy: () => base.containers.createPolicy(),
      connectTerminal: (id: string, handlers: Parameters<typeof base.containers.connectTerminal>[1]) =>
        base.containers.connectTerminal(id, handlers),
      sendTerminalInput: (sessionId: string, line: string) => base.containers.sendTerminalInput(sessionId, line),
      interruptTerminal: (sessionId: string) => base.containers.interruptTerminal(sessionId),
      completeTerminal: (sessionId: string, draft: string, cursor: number) =>
        base.containers.completeTerminal(sessionId, draft, cursor),
      disconnectTerminal: (sessionId: string) => base.containers.disconnectTerminal(sessionId),
      create: (input: ContainerCreateInput) => base.containers.create(input),
      removeImage: (imageId: string) => base.containers.removeImage(imageId),
      pullImage: (input: { name: string; tag: string }) => base.containers.pullImage(input),
      watchLive: (handlers: Parameters<typeof base.containers.watchLive>[0]) => base.containers.watchLive(handlers),
      requestAction: async (id: string) => CONTAINERS.find((c) => c.id === id)!,
      // 工作区直通 mock 实现：页面测试不覆盖它时也该拿到可用的演示行为。
      listApps: () => base.containers.listApps(),
      createApp: (input: { slug: string; displayName: string }) => base.containers.createApp(input),
      removeApp: (slug: string) => base.containers.removeApp(slug),
      uploadAppFile: (slug: string, path: string, file: Blob) => base.containers.uploadAppFile(slug, path, file),
      removeAppFile: (slug: string, path: string) => base.containers.removeAppFile(slug, path),
      readAppContent: (slug: string, path: string) => base.containers.readAppContent(slug, path),
      writeAppContent: (slug: string, path: string, content: string) =>
        base.containers.writeAppContent(slug, path, content),
      checkCompose: (slug: string, path: string) => base.containers.checkCompose(slug, path),
      previewAppBuild: (slug: string, input: Parameters<typeof base.containers.previewAppBuild>[1]) =>
        base.containers.previewAppBuild(slug, input),
      submitAppBuild: (slug: string, input: Parameters<typeof base.containers.submitAppBuild>[1]) =>
        base.containers.submitAppBuild(slug, input),
      listAppBuilds: (slug: string) => base.containers.listAppBuilds(slug),
      getAppBuild: (slug: string, taskId: string) => base.containers.getAppBuild(slug, taskId),
      getAppBuildLogs: (slug: string, taskId: string, offset: number) =>
        base.containers.getAppBuildLogs(slug, taskId, offset),
      cancelAppBuild: (slug: string, taskId: string) => base.containers.cancelAppBuild(slug, taskId),
    },
    overrides,
  )
  return { ...base, containers }
}

beforeEach(() => {
  // 通知是模块级共享态：镜像刷新等操作现在也走通知，不清会跨用例串台。
  useNotificationStore.getState().clear()
  useContainersStore.setState({
    status: 'idle', errorMessage: undefined, containers: [], images: [], imageRefreshStatus: 'idle', samples: {},
    view: 'grid', statusFilter: 'all', search: '', detailContainerId: undefined,
    terminal: undefined, busyActions: [], createOpen: false, creating: false, removingImageIds: [],
    pullingImage: undefined,
  })
})

describe('容器页骨架', () => {
  it('进入页面渲染全部 10 个容器', async () => {
    renderApp('/docker', { gateway: pageGateway() })
    const list = await screen.findByRole('list', { name: '容器列表' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(10)
  })

  it('mock 网关依赖恒 ok：页面成功态不出现安装引导弹窗', async () => {
    renderApp('/docker', { gateway: pageGateway() })
    await screen.findByRole('list', { name: '容器列表' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('状态筛选只保留所选状态的容器', async () => {
    const user = userEvent.setup()
    renderApp('/docker', { gateway: pageGateway() })
    await screen.findByRole('list', { name: '容器列表' })

    await user.click(screen.getByRole('button', { name: '已停止' }))
    const list = screen.getByRole('list', { name: '容器列表' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(list.textContent).toContain('backup-agent')
  })

  it('搜索按名称过滤，无结果显示专属空态', async () => {
    const user = userEvent.setup()
    renderApp('/docker', { gateway: pageGateway() })
    await screen.findByRole('list', { name: '容器列表' })

    await user.type(screen.getByLabelText('搜索容器名称'), 'nginx')
    expect(screen.getByRole('list', { name: '容器列表' }).textContent).toContain('nginx-proxy')

    await user.clear(screen.getByLabelText('搜索容器名称'))
    await user.type(screen.getByLabelText('搜索容器名称'), '不存在的容器')
    expect(await screen.findByText('没有匹配的容器')).toBeInTheDocument()
  })

  it('加载失败渲染错误态并可重试', async () => {
    const user = userEvent.setup()
    let fail = true
    const gateway = pageGateway({
      list: async () => {
        if (fail) throw new Error('演示连接失败')
        return [...(CONTAINERS as readonly Container[])]
      },
    })
    renderApp('/docker', { gateway })
    expect(await screen.findByText('容器数据加载失败')).toBeInTheDocument()
    // mock 网关依赖恒 ok：错误态不叠加安装引导弹窗。
    expect(screen.queryByRole('dialog')).toBeNull()

    fail = false
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('list', { name: '容器列表' })).toBeInTheDocument()
  })

  it('数据集为空渲染空态', async () => {
    renderApp('/docker', {
      gateway: pageGateway({
        list: async () => [],
        listImages: async () => [] as readonly ContainerImage[],
      }),
    })
    expect(await screen.findByText('还没有容器')).toBeInTheDocument()
  })
})

describe('容器卡片', () => {
  it('卡片显示名称、ID 前 13 位、镜像、状态标签与端口映射', async () => {
    renderApp('/docker', { gateway: pageGateway() })
    const card = await screen.findByRole('listitem', { name: 'nginx-proxy' })
    expect(card.textContent).toContain('ctr-nginx-pro')
    expect(card.textContent).toContain('nginx:1.27-alpine')
    expect(card.textContent).toContain('运行中')
    expect(card.textContent).toContain('80 → 8080/tcp')
    expect(card.textContent).toContain('443 → 8443/tcp')
  })

  it('运行中卡片有实时资源数值；停止的卡片资源显示 — 且终端禁用', async () => {
    renderApp('/docker', { gateway: pageGateway() })
    const running = await screen.findByRole('listitem', { name: 'nginx-proxy' })
    expect(running.textContent).toMatch(/CPU \d+%/)
    expect(running.textContent).toMatch(/内存 \d+ MB/)

    const stopped = screen.getByRole('listitem', { name: 'backup-agent' })
    expect(stopped.textContent).toContain('CPU —')
    expect(stopped.textContent).toContain('内存 —')
    expect(within(stopped).getByRole('button', { name: '终端' })).toBeDisabled()
    expect(within(stopped).queryByRole('button', { name: '停止' })).not.toBeInTheDocument()
    expect(within(stopped).getByRole('button', { name: '启动' })).toBeEnabled()
  })

  it('停止与重启是危险操作：取消不执行，确认后才执行', async () => {
    const user = userEvent.setup()
    renderApp('/docker', { gateway: pageGateway() })
    const card = await screen.findByRole('listitem', { name: 'nginx-proxy' })

    await user.click(within(card).getByRole('button', { name: '停止' }))
    const stopConfirm = await screen.findByRole('dialog', { name: '确认停止容器「nginx-proxy」？' })
    expect(stopConfirm.textContent).toContain('服务会中断')
    expect(stopConfirm.textContent).toContain('不会影响真实环境')
    await user.click(within(stopConfirm).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(card).getByText('运行中')).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: '重启' }))
    const restartConfirm = await screen.findByRole('dialog', { name: '确认重启容器「nginx-proxy」？' })
    await user.click(within(restartConfirm).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: '停止' }))
    await user.click(await screen.findByRole('button', { name: '确认停止' }))
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent('容器 nginx-proxy 已停止')
  })

  it('重启中的卡片操作全部禁用；卡片显示运行时长', async () => {
    renderApp('/docker', { gateway: pageGateway() })
    const restarting = await screen.findByRole('listitem', { name: 'metrics-agent' })
    for (const name of ['终端', '停止', '重启']) {
      expect(within(restarting).getByRole('button', { name })).toBeDisabled()
    }
    expect(restarting.textContent).toMatch(/运行时长 \d+ (天|小时|分钟)/)
  })
})

describe('镜像视图', () => {
  it('切换到镜像视图显示 8 行镜像与引用数', async () => {
    const user = userEvent.setup()
    renderApp('/docker', { gateway: pageGateway() })
    await screen.findByRole('list', { name: '容器列表' })
    expect(
      within(screen.getByRole('main')).getByRole('group', { name: '视图切换' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '镜像' }))
    const table = await screen.findByRole('table', { name: '镜像列表' })
    expect(within(table).getAllByRole('row')).toHaveLength(9) // 表头 + 8 行
    expect(table.textContent).toContain('node:22-alpine')
    expect(within(table).getByText('4')).toBeInTheDocument() // node 被引用 4 次
    expect(table.textContent).toContain('2026-09-03') // grafana 拉取时间：基准 09-12 08:00 回推 216 小时
    // 信息密度：名称行补摘要，未引用的镜像明说「未使用」而不是干巴巴的 0。
    expect(table.textContent).toContain('sha256:5d2fa6b8c417')
    expect(within(table).getByText('未使用')).toBeInTheDocument()
    // 表头与正文同尺寸（text-sm），只靠颜色与字重区分层级。
    expect(within(table).getByText('名称:标签')).toHaveClass('text-sm')

    await user.click(screen.getByRole('button', { name: '容器' }))
    expect(screen.getByRole('list', { name: '容器列表' })).toBeInTheDocument()
  })

  it('刷新后仍停在上次的视图', async () => {
    writeStoredViewTab(window.localStorage, 'containers', 'images')
    useContainersStore.setState({
      view: resolveViewTab(window.localStorage, 'containers', ['grid', 'images'] as const, 'grid'),
    })

    renderApp('/docker', { gateway: pageGateway() })

    expect(await screen.findByRole('table', { name: '镜像列表' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('main')).getByRole('button', { name: '镜像' }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('删除按钮按引用区分：被引用禁用并说明，未引用可发起删除', async () => {
    const user = userEvent.setup()
    renderApp('/docker', { gateway: pageGateway() })
    await screen.findByRole('list', { name: '容器列表' })
    await user.click(screen.getByRole('button', { name: '镜像' }))
    const table = await screen.findByRole('table', { name: '镜像列表' })

    const buttons = within(table).getAllByRole('button', { name: '删除' })
    expect(buttons).toHaveLength(8)
    for (const button of buttons) expect(button).toHaveAttribute('title')

    const rows = within(table).getAllByRole('row')
    const nodeRow = rows.find((row) => row.textContent?.includes('node:22-alpine'))!
    const nodeDelete = within(nodeRow).getByRole('button', { name: '删除' })
    expect(nodeDelete).toBeDisabled()
    expect(nodeDelete).toHaveAttribute('title', expect.stringContaining('4 个容器'))

    const grafanaRow = rows.find((row) => row.textContent?.includes('grafana/grafana'))!
    expect(within(grafanaRow).getByRole('button', { name: '删除' })).toBeEnabled()
  })

  it('删除落实到 mock：确认后行消失、通知带 mock 标注、数据集不再返回该镜像', async () => {
    const user = userEvent.setup()
    const gateway = pageGateway()
    renderApp('/docker', { gateway })
    await screen.findByRole('list', { name: '容器列表' })
    await user.click(screen.getByRole('button', { name: '镜像' }))
    const table = await screen.findByRole('table', { name: '镜像列表' })

    const rows = within(table).getAllByRole('row')
    const grafanaRow = rows.find((row) => row.textContent?.includes('grafana/grafana'))!
    await user.click(within(grafanaRow).getByRole('button', { name: '删除' }))

    const confirm = await screen.findByRole('dialog', { name: /确认删除镜像/ })
    expect(confirm.textContent).toContain('grafana/grafana:11.3.0')
    await user.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: /确认删除镜像/ })).not.toBeInTheDocument()
    expect(table.textContent).toContain('grafana/grafana')

    await user.click(within(grafanaRow).getByRole('button', { name: '删除' }))
    await user.click(
      within(await screen.findByRole('dialog', { name: /确认删除镜像/ })).getByRole('button', {
        name: '确认删除',
      }),
    )

    await waitFor(() => expect(table.textContent).not.toContain('grafana/grafana'))
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      '镜像 grafana/grafana:11.3.0 已删除（mock，待接入真实执行）',
    )
    // 数据落实到共享 mock 数据集：重新 listImages 也不再返回。
    const images = await gateway.containers.listImages()
    expect(images.map((image) => image.id)).not.toContain('img-grafana')
  })
})

describe('拉取镜像', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  async function openImagesView(gateway = pageGateway()) {
    const user = userEvent.setup()
    renderApp('/docker', { gateway })
    await screen.findByRole('list', { name: '容器列表' })
    await user.click(screen.getByRole('button', { name: '镜像' }))
    return { user, table: await screen.findByRole('table', { name: '镜像列表' }) }
  }

  it('每次选择镜像页签及点击刷新按钮都重新读取列表', async () => {
    const listImages = vi.fn(async () => [])
    const user = userEvent.setup()
    renderApp('/docker', { gateway: pageGateway({ listImages }) })
    await screen.findByRole('list', { name: '容器列表' })
    expect(listImages).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '镜像' }))
    await waitFor(() => expect(listImages).toHaveBeenCalledTimes(2))
    await user.click(screen.getByRole('button', { name: '镜像' }))
    await waitFor(() => expect(listImages).toHaveBeenCalledTimes(3))
    await user.click(screen.getByRole('button', { name: '刷新镜像' }))
    await waitFor(() => expect(listImages).toHaveBeenCalledTimes(4))
    // 刷新结果走全局通知组件，页面内不再有单独的反馈条。
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent('镜像列表已刷新')
  })

  it('镜像拉取行显示 Engine 提供的层进度与真实百分比', async () => {
    await openImagesView()
    await act(async () => {
      useContainersStore.setState({ pullingImage: {
        name: 'redis', tag: 'latest', progress: {
          phase: 'downloading', layerId: 'abcdef1234567890', currentBytes: 5 * 1024 * 1024, totalBytes: 10 * 1024 * 1024,
        },
      } })
    })
    expect(screen.getByRole('progressbar', { name: '镜像层拉取进度' })).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByText(/下载镜像层 abcdef123456/)).toBeInTheDocument()
    expect(screen.getByText('5.0 MB / 10.0 MB')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
  })

  it('镜像视图有拉取入口，打开弹窗见演示徽章、源地址与引用输入', async () => {
    const { user } = await openImagesView()
    await user.click(screen.getByRole('button', { name: /拉取镜像/ }))
    const dialog = await screen.findByRole('dialog', { name: '拉取镜像' })
    expect(dialog.textContent).toContain('演示 · 待接入真实执行')
    expect(within(dialog).getByLabelText('镜像引用')).toBeInTheDocument()
    // 源地址留空即默认官方：预览直接显示官方主机名。
    const address = within(dialog).getByLabelText('自定义镜像源地址')
    expect(address).toHaveValue('')
    await user.type(within(dialog).getByLabelText('镜像引用'), 'redis:9')
    expect(within(dialog).getByText('registry-1.docker.io/redis:9')).toBeInTheDocument()
  })

  it('填写自定义源后预览显示完整拉取路径', async () => {
    const { user } = await openImagesView()
    await user.click(screen.getByRole('button', { name: /拉取镜像/ }))
    const dialog = await screen.findByRole('dialog', { name: '拉取镜像' })
    await user.type(within(dialog).getByLabelText('自定义镜像源地址'), 'docker.1ms.run')
    await user.type(within(dialog).getByLabelText('镜像引用'), 'redis:9')
    expect(within(dialog).getByText('docker.1ms.run/redis:9')).toBeInTheDocument()
  })

  it('空引用禁用提交；已存在引用行内报错', async () => {
    const { user, table } = await openImagesView()
    await user.click(screen.getByRole('button', { name: /拉取镜像/ }))
    const dialog = await screen.findByRole('dialog', { name: '拉取镜像' })
    const input = within(dialog).getByLabelText('镜像引用')
    const submit = within(dialog).getByRole('button', { name: '拉取' })
    expect(submit).toBeDisabled()

    await user.type(input, 'redis:7.4-alpine')
    expect(await within(dialog).findByText('镜像已存在：redis:7.4-alpine')).toBeInTheDocument()
    expect(submit).toBeDisabled()
    expect(table.textContent).not.toContain('拉取中')
  })

  it('拉取全流程：提交后弹窗关、拉取中行出现，完成后入列并发 mock 通知', async () => {
    const user = userEvent.setup()
    renderApp('/docker', { gateway: pageGateway() })
    await screen.findByRole('list', { name: '容器列表' })
    await user.click(screen.getByRole('button', { name: '镜像' }))
    const table = await screen.findByRole('table', { name: '镜像列表' })
    await user.click(screen.getByRole('button', { name: /拉取镜像/ }))
    const dialog = await screen.findByRole('dialog', { name: '拉取镜像' })
    await user.type(within(dialog).getByLabelText('镜像引用'), 'redis:8-alpine')
    await user.click(within(dialog).getByRole('button', { name: '拉取' }))

    expect(screen.queryByRole('dialog', { name: '拉取镜像' })).not.toBeInTheDocument()
    expect(table.textContent).toContain('registry-1.docker.io/redis:8-alpine')
    expect(table.textContent).toContain('拉取中')

    // 真实等待 1.5s 模拟传输完成；时序由 store 的 PULL_DELAY_MS 决定。
    await waitFor(() => expect(table.textContent).not.toContain('拉取中'), { timeout: 3000 })
    expect(table.textContent).toContain('redis:8-alpine')
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      '镜像 redis:8-alpine 已拉取（mock，待接入真实执行）',
    )
  })
})

describe('容器详情面板', () => {
  it('点击详情打开右侧面板，分节展示完整配置', async () => {
    const user = userEvent.setup()
    renderApp('/docker', { gateway: pageGateway() })
    const card = await screen.findByRole('listitem', { name: 'postgres-db' })

    await user.click(within(card).getByRole('button', { name: '详情' }))
    const dialog = await screen.findByRole('dialog', { name: 'postgres-db' })

    expect(dialog.textContent).toContain('ctr-postgres-db')
    expect(dialog.textContent).toContain('运行中')
    expect(dialog.textContent).toContain('postgres:16.4')
    expect(dialog.textContent).toContain('sha256:2c9e55f0b7a3')
    expect(dialog.textContent).toContain('5432 → 15432/tcp')
    expect(dialog.textContent).toContain('POSTGRES_DB=elysian')
    expect(dialog.textContent).toContain('POSTGRES_USER=ops')
    expect(dialog.textContent).toContain('/srv/elysian/data/pg → /var/lib/postgresql/data')
    expect(dialog.textContent).toContain('除非手动停止')
    expect(dialog.textContent).toContain('postgres -c shared_buffers=256MB')

    // 七个分节各自成块：圆角描边卡片，节标题为三级标题。
    const headings = within(dialog).getAllByRole('heading', { level: 3 })
    expect(headings).toHaveLength(7)
    for (const heading of headings) {
      expect(heading.closest('section')).toHaveClass('panel-surface')
    }
  })

  it('Esc 关闭面板回到列表', async () => {
    const user = userEvent.setup()
    renderApp('/docker', { gateway: pageGateway() })
    const card = await screen.findByRole('listitem', { name: 'redis-cache' })
    await user.click(within(card).getByRole('button', { name: '详情' }))
    expect(await screen.findByRole('dialog', { name: 'redis-cache' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('演示终端', () => {
  // 只测页面接线：开窗、mock 标注、IME 与会话清理。
  // 历史召回、Tab 补全、Esc/外部不关闭等内核行为在 TerminalShell.test，
  // 命令输出与补全规则在 containerTerminal.test，不在这里重复。
  async function openTerminalOf(name: string) {
    const user = userEvent.setup()
    renderApp('/docker', { gateway: pageGateway() })
    const card = await screen.findByRole('listitem', { name })
    await user.click(within(card).getByRole('button', { name: '终端' }))
    const dialog = await screen.findByRole('dialog', { name: `${name} 终端` })
    return { user, dialog }
  }

  it('打开即见 mock 标注与横幅，输入 help 得到可用命令，未知命令给中文提示', async () => {
    const { user, dialog } = await openTerminalOf('nginx-proxy')
    expect(dialog.textContent).toContain('演示终端 · 待接入真实执行')

    const input = within(dialog).getByLabelText('命令输入')
    expect(document.activeElement).toBe(input)
    await user.type(input, 'help{Enter}')
    const log = within(dialog).getByRole('log')
    await waitFor(() => expect(log).toHaveTextContent('可用命令'))

    await user.type(input, 'rm -rf /{Enter}')
    await waitFor(() => expect(log).toHaveTextContent('不在演示集内'))
  })

  it('Ctrl+C 留下中断行，Ctrl+L 清屏但历史保留', async () => {
    const { user, dialog } = await openTerminalOf('nginx-proxy')
    const input = within(dialog).getByLabelText('命令输入')
    await user.type(input, 'env{Enter}')
    expect(await within(dialog).findByText('TZ=Asia/Shanghai')).toBeInTheDocument()

    await user.type(input, 'ps')
    await user.keyboard('{Control>}c{/Control}')
    expect(within(dialog).getByText('$ ps^C')).toBeInTheDocument()
    expect(input).toHaveValue('')

    await user.keyboard('{Control>}l{/Control}')
    expect(within(dialog).queryByText('TZ=Asia/Shanghai')).not.toBeInTheDocument()

    await user.keyboard('{ArrowUp}')
    expect(input).toHaveValue('env')
  })

  it('点击日志区把焦点交回命令输入', async () => {
    const { user, dialog } = await openTerminalOf('nginx-proxy')
    const input = within(dialog).getByLabelText('命令输入')

    await user.click(within(dialog).getByRole('button', { name: '关闭终端' }))
    await user.click(await screen.findByRole('button', { name: '继续使用' }))
    expect(document.activeElement).not.toBe(input)

    await user.click(within(dialog).getByRole('log'))
    expect(document.activeElement).toBe(input)
  })

  it('终端内的 Tab 只服务命令行：从关闭按钮按 Tab 回到输入框', async () => {
    const { dialog } = await openTerminalOf('nginx-proxy')
    const input = within(dialog).getByLabelText('命令输入')
    const close = within(dialog).getByRole('button', { name: '关闭终端' })

    close.focus()
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(input)
  })

  it('输入法组合中的回车与方向键只服务候选词，不发送也不召回历史', async () => {
    const { user, dialog } = await openTerminalOf('nginx-proxy')
    const input = within(dialog).getByLabelText('命令输入')

    await user.type(input, 'env')
    // 组合中的回车：确认候选/上屏原字符，绝不能当成发送。
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(within(dialog).queryByText('TZ=Asia/Shanghai')).not.toBeInTheDocument()

    // Safari 顺序：确认回车的 keydown 派发于 compositionend 之后，isComposing 已为 false，
    // 仍需被吞掉一次。
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(within(dialog).queryByText('TZ=Asia/Shanghai')).not.toBeInTheDocument()
    expect(input).toHaveValue('env')

    // 用户随后真正按下回车才发送；发送后组合中的方向键用于选词，不召回历史。
    await user.type(input, '{Enter}')
    expect(await within(dialog).findByText('TZ=Asia/Shanghai')).toBeInTheDocument()
    await user.type(input, 'ps')
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveValue('ps')
    fireEvent.compositionEnd(input)
  })

  it('关闭后会话清空，重开只剩横幅', async () => {
    const { user, dialog } = await openTerminalOf('nginx-proxy')
    const input = within(dialog).getByLabelText('命令输入')
    await user.type(input, 'env{Enter}')
    await user.click(within(dialog).getByRole('button', { name: '关闭终端' }))
    await user.click(await screen.findByRole('button', { name: '确认关闭' }))

    const card = screen.getByRole('listitem', { name: 'nginx-proxy' })
    await user.click(within(card).getByRole('button', { name: '终端' }))
    const reopened = await screen.findByRole('dialog', { name: 'nginx-proxy 终端' })
    expect(reopened.textContent).not.toContain('TZ=Asia/Shanghai')
  })
})

describe('容器操作联动', () => {
  it('停止操作经事件流回流：卡片变已停止、终端禁用、右上角出现通知', async () => {
    const user = userEvent.setup()
    renderApp('/docker', {
      gateway: createMockGateway({ eventStream: 'memory', eventIntervalMs: 50 }),
    })
    const card = await screen.findByRole('listitem', { name: 'nginx-proxy' })

    await user.click(within(card).getByRole('button', { name: '停止' }))
    await user.click(await screen.findByRole('button', { name: '确认停止' }))

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent('容器 nginx-proxy 已停止')
    const stopped = await screen.findByRole('listitem', { name: 'nginx-proxy' })
    expect(stopped.textContent).toContain('已停止')
    expect(within(stopped).getByRole('button', { name: '终端' })).toBeDisabled()
    expect(within(stopped).getByRole('button', { name: '启动' })).toBeEnabled()
  })

  it('重启操作的通知带 mock 标注，且随后回到运行中', async () => {
    const user = userEvent.setup()
    renderApp('/docker', {
      gateway: createMockGateway({ eventStream: 'memory', eventIntervalMs: 50 }),
    })
    const card = await screen.findByRole('listitem', { name: 'redis-cache' })

    await user.click(within(card).getByRole('button', { name: '重启' }))
    await user.click(await screen.findByRole('button', { name: '确认重启' }))

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      '已请求重启 redis-cache（mock，待接入真实执行）',
    )
    await waitFor(() => {
      expect(screen.getByRole('listitem', { name: 'redis-cache' }).textContent).toContain('运行中')
    })
  })
})

async function pickImage(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, label: string) {
  await user.click(within(dialog).getByRole('button', { name: /镜像/ }))
  await user.click(await screen.findByRole('menuitemradio', { name: label }))
}

describe('创建容器', () => {
  async function openCreateForm(gateway = pageGateway()) {
    const user = userEvent.setup()
    renderApp('/docker', { gateway })
    await screen.findByRole('list', { name: '容器列表' })
    await user.click(screen.getByRole('button', { name: '创建容器' }))
    const dialog = await screen.findByRole('dialog', { name: '创建容器' })
    return { user, dialog }
  }

  it('打开表单见 mock 徽章；可选设置默认收起，展开后可加端口行', async () => {
    const { user, dialog } = await openCreateForm()
    expect(dialog.textContent).toContain('演示 · 待接入真实执行')
    expect(dialog.querySelector('select')).toBeNull()
    expect(within(dialog).queryByLabelText('容器端口')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /可选设置/ }))
    await user.click(within(dialog).getByRole('button', { name: '添加端口映射' }))
    expect(within(dialog).getByLabelText('容器端口')).toBeInTheDocument()
  })

  it('点弹窗外部不关闭，已填配置保留', async () => {
    const { user, dialog } = await openCreateForm()
    await user.type(within(dialog).getByLabelText('容器名称'), 'keep-me')

    // 同终端用例：外部子树被设为 aria-hidden（查询带 hidden），body 锁了 pointer-events，改用 fireEvent。
    fireEvent.pointerDown(screen.getByRole('list', { name: '容器列表', hidden: true }))
    expect(screen.getByRole('dialog', { name: '创建容器' })).toBeInTheDocument()
    expect(within(dialog).getByLabelText('容器名称')).toHaveValue('keep-me')
  })

  it('未选镜像提交显示行内错误，不产生新容器', async () => {
    const { user, dialog } = await openCreateForm()
    await user.click(within(dialog).getByRole('button', { name: '创建并运行' }))
    expect(await within(dialog).findByText('请选择镜像')).toBeInTheDocument()
    // 弹窗打开时 Radix 会把应用子树设为 aria-hidden，按本文件终端用例的既有写法带 hidden 查询。
    expect(screen.getAllByRole('listitem', { hidden: true })).toHaveLength(10)
  })

  it('宿主端口与现有容器冲突显示行内错误', async () => {
    const { user, dialog } = await openCreateForm()
    await pickImage(user, dialog, 'redis:7.4-alpine')
    await user.click(within(dialog).getByRole('button', { name: /可选设置/ }))
    await user.click(within(dialog).getByRole('button', { name: '添加端口映射' }))
    await user.type(within(dialog).getByLabelText('容器端口'), '6379')
    await user.type(within(dialog).getByLabelText('宿主端口'), '8080')
    await user.click(within(dialog).getByRole('button', { name: '创建并运行' }))
    expect(await within(dialog).findByText('宿主端口已被占用')).toBeInTheDocument()
  })

  it('创建成功：新卡片出现、通知带 mock 标注、弹窗关闭', async () => {
    const { user, dialog } = await openCreateForm(
      createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 }),
    )
    await pickImage(user, dialog, 'redis:7.4-alpine')
    await user.type(within(dialog).getByLabelText('容器名称'), 'redis-echo')
    await user.click(within(dialog).getByRole('button', { name: /可选设置/ }))
    await user.click(within(dialog).getByRole('button', { name: '添加环境变量' }))
    await user.type(within(dialog).getByLabelText('变量名'), 'TZ')
    await user.type(within(dialog).getByLabelText('值'), 'Asia/Shanghai')
    await user.click(within(dialog).getByRole('button', { name: '创建并运行' }))

    const card = await screen.findByRole('listitem', { name: 'redis-echo' })
    expect(within(card).getByText('redis:7.4-alpine')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '创建容器' })).not.toBeInTheDocument()
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      '容器 redis-echo 已创建（mock，待接入真实执行）',
    )
  })

  it('名称留空时按镜像自动命名', async () => {
    const { user, dialog } = await openCreateForm(
      createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 }),
    )
    await pickImage(user, dialog, 'alpine:3.20')
    await user.click(within(dialog).getByRole('button', { name: '创建并运行' }))
    expect(await screen.findByRole('listitem', { name: 'alpine' })).toBeInTheDocument()
  })
})
