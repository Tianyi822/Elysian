import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useContainerAppsStore } from '../../stores/containerAppsStore'
import { useContainersStore } from '../../stores/containersStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { renderApp } from '../../test/renderApp'

/**
 * 应用工作区面板测试：整页渲染后切到「应用工作区」页签，
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
  await user.click(screen.getByRole('button', { name: '应用工作区' }))
  return user
}

/** 走完「建工作区」这一步，返回该卡片，后续上传与删除都从它出发。 */
async function createWorkspace(user: ReturnType<typeof userEvent.setup>, slug: string) {
  // 空态里工具栏与空态卡片各有一个「新建工作区」，取工具栏那个。
  await user.click(screen.getAllByRole('button', { name: '新建工作区' })[0]!)
  const dialog = await screen.findByRole('dialog')
  await user.type(within(dialog).getByLabelText(/工作区标识/), slug)
  await user.click(within(dialog).getByRole('button', { name: '创建工作区' }))
  const card = await screen.findByRole('listitem', { name: `应用工作区 ${slug}` })
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
  })
})

describe('应用工作区面板', () => {
  it('首次进入给出空态与新建入口', async () => {
    await openAppsView()
    expect(await screen.findByText('还没有应用工作区')).toBeTruthy()
  })

  it('加载失败给出错误态与重试，不是一片空白', async () => {
    const gateway = appsGateway({
      listApps: async () => {
        throw new Error('应用工作区读取失败')
      },
    })
    await openAppsView(gateway)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('应用工作区加载失败')
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
    expect(screen.queryByRole('listitem', { name: '应用工作区 demo-app' })).toBeTruthy()

    await user.click(within(card).getByRole('button', { name: '删除工作区' }))
    const second = await screen.findByRole('dialog')
    await user.click(within(second).getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(screen.queryByRole('listitem', { name: '应用工作区 demo-app' })).toBeNull())
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
    expect(screen.queryByRole('listitem', { name: '应用工作区 demo-app' })).toBe(card)
    expect(screen.queryByText('正在加载应用工作区…')).toBeNull()

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
    const card = await screen.findByRole('listitem', { name: '应用工作区 demo-app' })

    expect(card.textContent).toContain('/srv/elysian/apps/demo-app/certs/server.p12')
    const edit = within(card).getByRole('button', { name: '二进制文件不支持编辑' })
    expect(edit).toHaveAttribute('disabled')
    expect(within(card).queryByRole('button', { name: '编辑内容' })).toBeNull()
  })
})
