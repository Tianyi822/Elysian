import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContainerApp, ContainerBuildTask } from '@elysian/contracts'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useContainerAppsStore } from '../../stores/containerAppsStore'
import { useContainersStore } from '../../stores/containersStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { renderApp } from '../../test/renderApp'

/**
 * 工作区面板测试：整页渲染后切到「工作区」页签，
 * 数据走 mock 演示实现（内存工作区），需要观察失败与在途的用例按接口覆盖。
 *
 * mock 的容器 adapter 是类实例，方法挂在原型上，`{ ...base.containers }` 会把它们全部丢掉
 * （页面随即报 `list is not a function`）。所以个别接口的覆盖以实例为原型再派一层，
 * 未覆盖的接口沿原型链落到原实现，`this` 也仍指向带数据集的那个实例。
 */
function appsGatewayWith(
  apply: (base: ElysianGateway) => Partial<ElysianGateway['containers']> = () => ({}),
): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  return { ...base, containers: Object.assign(Object.create(base.containers), apply(base)) }
}

function appsGateway(overrides: Partial<ElysianGateway['containers']>): ElysianGateway {
  return appsGatewayWith(() => overrides)
}

async function openAppsView(gateway: ElysianGateway = appsGatewayWith()) {
  const user = userEvent.setup()
  renderApp('/docker', { gateway })
  await screen.findByRole('list', { name: '容器列表' })
  await user.click(screen.getByRole('button', { name: '工作区' }))
  return user
}

/** 走完「建工作区」这一步，返回该卡片，后续上传与删除都从它出发。 */
async function createWorkspace(user: ReturnType<typeof userEvent.setup>, slug: string) {
  // 空态里工具栏与空态卡片各有一个「新建工作区」，取工具栏那个。
  await user.click(screen.getAllByRole('button', { name: '新建工作区' })[0]!)
  const dialog = await screen.findByRole('dialog')
  await user.type(within(dialog).getByLabelText(/工作区标识/), slug)
  await user.click(within(dialog).getByRole('button', { name: '创建工作区' }))
  const card = await screen.findByRole('listitem', { name: `工作区 ${slug}` })
  expect(screen.queryByRole('dialog')).toBeNull()
  return card
}

const composeYaml = [
  'services:',
  '  app:',
  '    env_file:',
  '      - ./.env',
  '    volumes:',
  '      - ./config/app.yml:/etc/app.yml:ro',
  '',
].join('\n')

beforeEach(() => {
  useNotificationStore.getState().clear()
  useContainersStore.setState({ view: 'grid' })
  useContainerAppsStore.setState({
    status: 'idle',
    apps: [],
    errorMessage: undefined,
    refreshing: false,
    creating: false,
    createError: null,
    writing: null,
    check: null,
    buildsBySlug: {},
    buildsLoading: {},
    buildsRefreshing: {},
    buildsError: {},
    buildPreview: null,
    buildLogs: {},
  })
})

describe('工作区面板', () => {
  it('Docker 引擎加载失败时仍可进入和创建文件工作区', async () => {
    const user = userEvent.setup()
    renderApp('/docker', { gateway: appsGateway({ list: async () => { throw new Error('Docker 服务未就绪') } }) })
    await screen.findByText('容器数据加载失败')
    await user.click(screen.getByRole('button', { name: '工作区' }))
    await screen.findByText('还没有工作区')
    const card = await createWorkspace(user, 'engine-offline')
    expect(card.textContent).toContain('/srv/elysian/apps/engine-offline')
  })

  it('首次进入给出空态与新建入口', async () => {
    await openAppsView()
    expect(await screen.findByText('还没有工作区')).toBeTruthy()
  })

  it('加载失败给出错误态与重试，不是一片空白', async () => {
    const gateway = appsGateway({
      listApps: async () => {
        throw new Error('工作区读取失败')
      },
    })
    await openAppsView(gateway)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('工作区加载失败')
    expect(within(alert).getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('创建工作区后卡片显示可直接抄的真实路径', async () => {
    const user = await openAppsView()
    const card = await createWorkspace(user, 'gateway-prod')
    expect(card.textContent).toContain('/srv/elysian/apps/gateway-prod')
    expect(card.textContent).toContain('还没有文件')
  })

  it('非法标识只在表单内报错，不提交到适配层', async () => {
    let called = 0
    const gateway = appsGateway({
      createApp: async () => {
        called += 1
        throw new Error('不该被调用')
      },
    })
    const user = await openAppsView(gateway)
    await user.click(screen.getAllByRole('button', { name: '新建工作区' })[0]!)
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/工作区标识/), 'Bad Name')
    await user.click(within(dialog).getByRole('button', { name: '创建工作区' }))

    expect(await within(dialog).findByText(/只能由小写字母、数字、下划线和连字符组成/)).toBeTruthy()
    expect(called).toBe(0)
    // 提交被拦下时输入不清空，改两个字符就能重来。
    expect(within(dialog).getByLabelText<HTMLInputElement>(/工作区标识/).value).toBe('Bad Name')
  })

  it('上传后每个文件都回显完整真实路径', async () => {
    const user = await openAppsView()
    const card = await createWorkspace(user, 'demo-app')
    const input = card.querySelector('input[type="file"]') as HTMLInputElement

    fireEvent.change(input, { target: { files: [new File(['A=1\n'], '.env')] } })
    await within(card).findByText('.env')

    expect(card.textContent).toContain('/srv/elysian/apps/demo-app/.env')
    expect(await screen.findByText('已上传 .env')).toBeTruthy()
    expect(within(card).getByRole('button', { name: '复制文件真实路径' })).toBeTruthy()
  })

  it('上传 compose 后自动自检，逐条给出引用路径与判定范围', async () => {
    const user = await openAppsView()
    const card = await createWorkspace(user, 'demo-app')
    const input = card.querySelector('input[type="file"]') as HTMLInputElement

    fireEvent.change(input, { target: { files: [new File(['A=1\n'], '.env')] } })
    await within(card).findByText('.env')
    fireEvent.change(input, { target: { files: [new File([composeYaml], 'compose.yml')] } })

    const panel = await screen.findByRole('region', { name: 'compose 路径自检' })
    expect(await within(panel).findByText('2 条路径引用中，1 条在工作区内找不到对应文件。')).toBeTruthy()
    expect(panel.textContent).toContain('工作区内已存在')
    expect(panel.textContent).toContain('工作区内找不到')
    expect(panel.textContent).toContain('/srv/elysian/apps/demo-app/config/app.yml')
    // 判定范围必须同屏：不显示就容易被人当成全量 YAML 解析结论。
    expect(panel.textContent).toContain('只判定 volumes 短语法与长语法 source')
  })

  it('文本文件可编辑，保存后写回并回到一致态', async () => {
    const written: string[] = []
    const gateway = appsGatewayWith((base) => ({
      writeAppContent: (slug, path, content) => {
        written.push(`${slug}/${path}:${content}`)
        return base.containers.writeAppContent(slug, path, content)
      },
    }))
    const user = await openAppsView(gateway)
    const card = await createWorkspace(user, 'demo-app')
    const input = card.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['A=1\n'], '.env')] } })
    await within(card).findByText('.env')

    await user.click(within(card).getByRole('button', { name: '编辑内容' }))
    const sheet = await screen.findByRole('dialog')
    const editor = await within(sheet).findByLabelText('.env 的文件内容')
    await waitFor(() => expect(editor).toHaveValue('A=1\n'))

    await user.clear(editor)
    await user.type(editor, 'A=2')
    expect(await within(sheet).findByText('有未保存的修改。')).toBeTruthy()
    await user.click(within(sheet).getByRole('button', { name: '保存' }))
    expect(await screen.findByText('已保存 .env')).toBeTruthy()
    expect(written).toEqual(['demo-app/.env:A=2'])
    await waitFor(() => expect(within(sheet).getByText('内容与磁盘一致。')).toBeTruthy())

    await user.click(within(sheet).getByRole('button', { name: '关闭编辑器' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('未保存的改动不让一次误点丢掉', async () => {
    const user = await openAppsView()
    const card = await createWorkspace(user, 'demo-app')
    const input = card.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['A=1\n'], '.env')] } })
    await within(card).findByText('.env')

    await user.click(within(card).getByRole('button', { name: '编辑内容' }))
    const sheet = await screen.findByRole('dialog')
    const editor = await within(sheet).findByLabelText('.env 的文件内容')
    await waitFor(() => expect(editor).toHaveValue('A=1\n'))
    await user.clear(editor)
    await user.type(editor, 'TOUCHED')

    await user.click(within(sheet).getByRole('button', { name: '关闭编辑器' }))
    const warn = await within(sheet).findByRole('alert')
    expect(warn.textContent).toContain('有未保存的修改，关闭后这部分改动会丢失。')
    await user.click(within(warn).getByRole('button', { name: '继续编辑' }))
    expect(within(sheet).getByRole('button', { name: '保存' })).toBeTruthy()
    expect(within(sheet).getByLabelText<HTMLInputElement>('.env 的文件内容').value).toBe('TOUCHED')
  })

  it('删除工作区要先确认，确认文案逐字写出将被删除的目录', async () => {
    const user = await openAppsView()
    const card = await createWorkspace(user, 'demo-app')

    await user.click(within(card).getByRole('button', { name: '删除工作区' }))
    const confirm = await screen.findByRole('dialog', { name: '确认删除工作区「demo-app」？' })
    expect(confirm.textContent).toContain('/srv/elysian/apps/demo-app')

    await user.click(within(confirm).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('listitem', { name: '工作区 demo-app' })).toBeTruthy()

    await user.click(within(card).getByRole('button', { name: '删除工作区' }))
    const second = await screen.findByRole('dialog')
    await user.click(within(second).getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(screen.queryByRole('listitem', { name: '工作区 demo-app' })).toBeNull())
    expect(await screen.findByText('已删除工作区 demo-app 及其目录')).toBeTruthy()
  })

  it('刷新时旧清单留在屏上并只盖一层组件遮罩', async () => {
    let hang = false
    let release: (() => void) | undefined
    const gateway = appsGatewayWith((base) => ({
      listApps: () => {
        if (!hang) return base.containers.listApps()
        return new Promise((resolve) => {
          release = () => resolve(base.containers.listApps())
        })
      },
    }))
    const user = await openAppsView(gateway)
    const card = await createWorkspace(user, 'demo-app')

    hang = true
    await user.click(screen.getByRole('button', { name: '刷新工作区' }))
    await waitFor(() => expect(document.querySelector('.busy-veil')).toBeTruthy())
    // 白屏检查：遮罩盖上时卡片还是同一块内容，而不是换成加载态。
    expect(screen.queryByRole('listitem', { name: '工作区 demo-app' })).toBe(card)
    expect(screen.queryByText('正在加载工作区…')).toBeNull()

    await act(async () => {
      release?.()
    })
    await waitFor(() => expect(document.querySelector('.busy-veil')).toBeNull())
  })

  it('二进制文件不给编辑入口，只给路径', async () => {
    const gateway = appsGateway({
      listApps: async () => [
        {
          slug: 'demo-app',
          displayName: 'demo-app',
          createdAt: '2026-10-01T00:00:00.000Z',
          directory: '/srv/elysian/apps/demo-app',
          files: [
            { path: 'certs/server.p12', size: 2048, modifiedAt: '2026-10-02T00:00:00.000Z', text: false },
          ],
        },
      ],
    })
    await openAppsView(gateway)
    const card = await screen.findByRole('listitem', { name: '工作区 demo-app' })

    expect(card.textContent).toContain('/srv/elysian/apps/demo-app/certs/server.p12')
    const edit = within(card).getByRole('button', { name: '二进制文件不支持编辑' })
    expect(edit).toHaveAttribute('disabled')
    expect(within(card).queryByRole('button', { name: '编辑内容' })).toBeNull()
  })
})

/** 构建任务区的固定样例：状态、结果与镜像 tag 的形状对齐任务对象契约。 */
const buildDemoApp: ContainerApp = {
  slug: 'demo-app',
  displayName: 'demo-app',
  createdAt: '2026-10-01T00:00:00.000Z',
  directory: '/srv/elysian/apps/demo-app',
  files: [{ path: 'Dockerfile', size: 20, modifiedAt: '2026-10-01T00:00:00.000Z', text: true }],
}

const succeededBuildTask: ContainerBuildTask = {
  id: '1001b1d5-build-1',
  slug: 'demo-app',
  mode: 'dockerfile',
  requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b',
  state: 'succeeded',
  stage: '构建成功',
  createdAt: '2026-10-04T07:30:00Z',
  updatedAt: '2026-10-04T07:31:00Z',
  input: { mode: 'dockerfile', requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b', dockerfile: 'Dockerfile' },
  results: [
    {
      target: 'app',
      repository: 'elysian/demo-app/app',
      tag: '20261004-073000-1001',
      imageId: 'sha256:abcd0123',
      state: 'succeeded',
      error: '',
    },
  ],
  error: '',
}

/** 多服务失败样例：首个成功目标保留镜像，失败目标带原文，任务级 error 取首个失败原文。 */
const failedComposeBuildTask: ContainerBuildTask = {
  id: '1002b1d5-build-2',
  slug: 'demo-app',
  mode: 'compose',
  requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5c',
  state: 'failed',
  stage: '构建失败',
  createdAt: '2026-10-04T08:00:00Z',
  updatedAt: '2026-10-04T08:02:00Z',
  input: {
    mode: 'compose',
    requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5c',
    compose: 'compose.yml',
    services: ['web', 'api'],
  },
  results: [
    {
      target: 'web',
      repository: 'elysian/demo-app/web',
      tag: '20261004-080000-1002',
      imageId: 'sha256:aaaa',
      state: 'succeeded',
      error: '',
    },
    {
      target: 'api',
      repository: 'elysian/demo-app/api',
      tag: '20261004-080000-1002',
      imageId: '',
      state: 'failed',
      error: '构建失败：演示错误',
    },
  ],
  error: '构建失败：演示错误',
}

function buildsGateway(
  tasks: readonly ContainerBuildTask[],
  extra: Partial<ElysianGateway['containers']> = {},
): ElysianGateway {
  return appsGateway({
    listApps: async () => [buildDemoApp],
    listAppBuilds: async () => [...tasks],
    ...extra,
  })
}

async function openBuildArea(gateway: ElysianGateway) {
  const user = await openAppsView(gateway)
  const card = await screen.findByRole('listitem', { name: '工作区 demo-app' })
  await user.click(within(card).getByRole('button', { name: /^构建任务/ }))
  return { user, card }
}

describe('工作区构建任务区', () => {
  it('卡片提供「构建镜像」入口，点开构建弹窗', async () => {
    const { user, card } = await openBuildArea(buildsGateway([]))
    await user.click(within(card).getByRole('button', { name: '构建镜像' }))
    expect(await screen.findByRole('dialog', { name: /构建镜像 · demo-app/ })).toBeTruthy()
  })

  it('成功任务显示中文状态标签与常驻的完整镜像 tag 和复制入口', async () => {
    const { card } = await openBuildArea(buildsGateway([succeededBuildTask]))
    expect((await within(card).findAllByText('构建成功')).length).toBeGreaterThan(0)
    expect(within(card).getByText('elysian/demo-app/app:20261004-073000-1001')).toBeTruthy()
    expect(within(card).getByRole('button', { name: '复制完整镜像标签' })).toBeTruthy()
    // 终态任务给「重新构建」，不给「取消」。
    expect(within(card).getByRole('button', { name: '重新构建' })).toBeTruthy()
    expect(within(card).queryByRole('button', { name: '取消' })).toBeNull()
  })

  it('多服务失败任务展示任务级错误原文与已完成目标的保留镜像', async () => {
    const { card } = await openBuildArea(buildsGateway([failedComposeBuildTask]))
    expect((await within(card).findAllByText('构建失败')).length).toBeGreaterThan(0)
    expect(within(card).getByText('构建失败：演示错误')).toBeTruthy()
    // 已完成目标 web 的镜像保留并常驻可复制；失败目标 api 只显示错误。
    expect(within(card).getByText('elysian/demo-app/web:20261004-080000-1002')).toBeTruthy()
    expect(within(card).getByText('api：构建失败：演示错误')).toBeTruthy()
    expect(within(card).queryByText(/elysian\/demo-app\/api:/)).toBeNull()
  })

  it('活跃任务提供「取消」并要求二次确认', async () => {
    const active = { ...succeededBuildTask, state: 'building' as const, stage: '构建镜像 elysian/demo-app/app', results: [] }
    let cancelled = false
    const gateway = buildsGateway([active], {
      cancelAppBuild: async () => {
        cancelled = true
      },
      listAppBuilds: async () => [
        cancelled ? { ...active, state: 'cancelled' as const, stage: '已取消', error: '构建已取消' } : active,
      ],
    })
    const { user, card } = await openBuildArea(gateway)
    expect(await within(card).findByText('构建中')).toBeTruthy()
    await user.click(within(card).getByRole('button', { name: '取消' }))
    const confirm = await screen.findByRole('dialog', { name: /取消构建任务 app？/ })
    expect(confirm.textContent).toContain('已完成的镜像会保留')
    await user.click(within(confirm).getByRole('button', { name: '确认取消' }))
    expect(await screen.findByText('已取消构建任务')).toBeTruthy()
    // 状态标签与阶段描述同名（「已取消」），两处都在才算取消落实。
    expect((await within(card).findAllByText('已取消')).length).toBeGreaterThan(1)
  })

  it('重新构建按原参数提交并生成新 requestId', async () => {
    const submitCalls: { requestId: string }[] = []
    const gateway = buildsGateway([succeededBuildTask], {
      submitAppBuild: async (_slug, input) => {
        submitCalls.push({ requestId: input.requestId })
        return { ...succeededBuildTask, id: '1003b1d5-build-3', state: 'queued', stage: '等待构建资源', results: [] }
      },
    })
    const { user, card } = await openBuildArea(gateway)
    await within(card).findAllByText('构建成功')
    await user.click(within(card).getByRole('button', { name: '重新构建' }))
    expect(await screen.findByText('已提交构建任务')).toBeTruthy()
    expect(submitCalls).toHaveLength(1)
    expect(submitCalls[0]!.requestId).not.toBe(succeededBuildTask.requestId)
    expect(submitCalls[0]!.requestId).toMatch(/^[a-f0-9-]{36}$/)
  })

  it('手动刷新只给任务区盖遮罩，旧任务行留在屏上不白屏', async () => {
    let hang = false
    let release: (() => void) | undefined
    const gateway = buildsGateway([succeededBuildTask], {
      listAppBuilds: () => {
        if (!hang) return Promise.resolve([succeededBuildTask])
        return new Promise((resolve) => {
          release = () => resolve([succeededBuildTask])
        })
      },
    })
    const { user, card } = await openBuildArea(gateway)
    await within(card).findAllByText('构建成功')

    hang = true
    await user.click(within(card).getByRole('button', { name: '刷新构建任务' }))
    await waitFor(() => expect(document.querySelector('.busy-veil')).toBeTruthy())
    expect(within(card).getAllByText('构建成功').length).toBeGreaterThan(0)
    expect(within(card).getByText('elysian/demo-app/app:20261004-073000-1001')).toBeTruthy()

    await act(async () => {
      release?.()
    })
    await waitFor(() => expect(document.querySelector('.busy-veil')).toBeNull())
  })

  it('任务清单读取失败给出中文错误与重试', async () => {
    let failFirst = true
    const gateway = buildsGateway([], {
      listAppBuilds: async () => {
        if (failFirst) {
          failFirst = false
          throw new Error('构建任务读取失败')
        }
        return [succeededBuildTask]
      },
    })
    const { user, card } = await openBuildArea(gateway)
    const alert = await within(card).findByRole('alert')
    expect(alert.textContent).toContain('构建任务读取失败')
    await user.click(within(alert).getByRole('button', { name: '重试' }))
    expect((await within(card).findAllByText('构建成功')).length).toBeGreaterThan(0)
  })

  it('日志抽屉打开拉全量，活跃任务每 2 秒按已读字节增量', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const active = { ...succeededBuildTask, state: 'building' as const, stage: '构建镜像 elysian/demo-app/app', results: [] }
      const logs = vi
        .fn()
        .mockResolvedValueOnce({ lines: ['打包构建上下文（1 个文件，20 字节）'], next: 45, total: 90 })
        .mockResolvedValueOnce({ lines: ['构建镜像 elysian/demo-app/app'], next: 90, total: 90 })
        .mockResolvedValue({ lines: [], next: 90, total: 90 })
      const gateway = buildsGateway([active], { getAppBuildLogs: logs })
      const { user, card } = await openBuildArea(gateway)
      await within(card).findByText('构建中')
      await user.click(within(card).getByRole('button', { name: '查看构建日志' }))
      const sheet = await screen.findByRole('dialog', { name: /构建日志 · 1001b1d5/ })
      expect(await within(sheet).findByText('打包构建上下文（1 个文件，20 字节）')).toBeTruthy()
      expect(within(sheet).getByText(/已读取 45 \/ 90 字节/)).toBeTruthy()

      await vi.advanceTimersByTimeAsync(2_100)
      await within(sheet).findByText('构建镜像 elysian/demo-app/app')
      expect(logs).toHaveBeenNthCalledWith(1, 'demo-app', active.id, 0)
      expect(logs).toHaveBeenNthCalledWith(2, 'demo-app', active.id, 45)

      await user.click(within(sheet).getByRole('button', { name: '关闭构建日志' }))
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /构建日志 ·/ })).toBeNull())
    } finally {
      vi.useRealTimers()
    }
  })

  it('任务区展开或存在活跃任务时每 2 秒静默刷新，收起且无活跃后停止', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const active = { ...succeededBuildTask, state: 'queued' as const, stage: '等待构建资源', results: [] }
      const listAppBuilds = vi.fn(async (): Promise<readonly ContainerBuildTask[]> => [active])
      const { user, card } = await openBuildArea(buildsGateway([active], { listAppBuilds }))
      await within(card).findByText('等待构建')

      // 活跃任务在跑：即使把任务区收起，轮询也继续（对齐 WebsitesPanel 先例）。
      await user.click(within(card).getByRole('button', { name: /^构建任务（1）/ }))
      const whileActive = listAppBuilds.mock.calls.length
      await vi.advanceTimersByTimeAsync(2_100)
      expect(listAppBuilds.mock.calls.length).toBeGreaterThan(whileActive)

      // 任务进入终态且任务区收起：轮询停止。
      listAppBuilds.mockImplementation(async () => [succeededBuildTask])
      await vi.advanceTimersByTimeAsync(2_100)
      await vi.advanceTimersByTimeAsync(5_000)
      const settled = listAppBuilds.mock.calls.length
      await vi.advanceTimersByTimeAsync(5_000)
      expect(listAppBuilds.mock.calls.length).toBe(settled)
    } finally {
      vi.useRealTimers()
    }
  })

  it('活跃构建任务把删除工作区拦下来，409 原文原样呈现', async () => {
    const active = { ...succeededBuildTask, state: 'building' as const, stage: '构建镜像 elysian/demo-app/app', results: [] }
    const gateway = buildsGateway([active], {
      removeApp: async () => {
        throw new Error('工作区有进行中的构建任务，请先取消或等待完成')
      },
    })
    const { user, card } = await openBuildArea(gateway)
    await within(card).findByText('构建中')

    await user.click(within(card).getByRole('button', { name: '删除工作区' }))
    const confirm = await screen.findByRole('dialog', { name: '确认删除工作区「demo-app」？' })
    await user.click(within(confirm).getByRole('button', { name: '确认删除' }))
    const notice = await screen.findByText(/删除工作区失败：工作区有进行中的构建任务，请先取消或等待完成/)
    expect(notice).toBeTruthy()
    // 工作区还在。
    expect(screen.getByRole('listitem', { name: '工作区 demo-app' })).toBeTruthy()
  })
})
