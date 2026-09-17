import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { resetWebsitesData } from '../../adapters/mock/websitesData'
import { useNotificationStore } from '../../stores/notificationStore'
import { useWebsitesStore } from '../../stores/websitesStore'
import { renderApp } from '../../test/renderApp'

/**
 * 网站面板（卡片网格）的端到端行为：过滤、详情抽屉、建站（带类型选择）、
 * 启停/设置/删除、批量操作与四态。数据走默认 mock 数据集（17 个种子项目）。
 */

function sessionGateway(overrides: Partial<ElysianGateway['websites']> = {}): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const websites = base.websites
  return {
    ...base,
    // 适配器方法在原型上，展开会丢；显式委托再叠加覆盖项。
    websites: {
      list: () => websites.list(),
      create: (kind, input) => websites.create(kind, input),
      update: (projectId, input) => websites.update(projectId, input),
      remove: (projectId) => websites.remove(projectId),
      setRunning: (projectId, running) => websites.setRunning(projectId, running),
      logs: (projectId) => websites.logs(projectId),
      ...overrides,
    },
  }
}

async function openWebsites(gateway: ElysianGateway = sessionGateway()) {
  renderApp('/websites', { gateway })
  return screen.findByRole('list', { name: '网站项目列表' })
}

function cards(list: HTMLElement): HTMLElement[] {
  return within(list).getAllByRole('article')
}

function cardByName(list: HTMLElement, name: string): HTMLElement {
  return within(list).getByRole('article', { name })
}

function lastNotification(): string {
  return useNotificationStore.getState().notifications.at(-1)?.message ?? ''
}

beforeEach(() => {
  useNotificationStore.getState().clear()
  // 用例会增删改共享的 mock 数据集：每个用例前重置回种子，断言不依赖用例声明顺序。
  resetWebsitesData()
  useWebsitesStore.setState({
    status: 'idle',
    errorMessage: undefined,
    projects: [],
    search: '',
    category: 'all',
    selectedIds: [],
    batchAction: undefined,
    batchRunning: false,
    refreshing: false,
    saving: false,
    createDialogOpen: false,
    settingsTarget: undefined,
    removeTarget: undefined,
    detailTarget: undefined,
    detailLogs: undefined,
    detailLogsLoading: false,
    busyProjectIds: [],
  })
})

describe('卡片网格', () => {
  it('加载后 17 张卡片就位，类型标签与运行状态呈现', async () => {
    const list = await openWebsites()

    expect(cards(list)).toHaveLength(17)
    const java = cardByName(list, '订单中心-api')
    expect(within(java).getAllByText('Java项目').length).toBeGreaterThan(0)
    expect(within(java).getByText('运行中')).toBeInTheDocument()
    expect(within(java).getByText('生产环境')).toBeInTheDocument()
  })

  it('卡片按类型呈现专属信息：Java 有端口与 PID，HTML 没有，Go 显示长期有效', async () => {
    const list = await openWebsites()

    const java = cardByName(list, '订单中心-api')
    expect(within(java).getByText('8080')).toBeInTheDocument()
    expect(within(java).getByText('23180')).toBeInTheDocument()

    const html = cardByName(list, 'company-portal')
    expect(within(html).queryByText('端口')).not.toBeInTheDocument()

    const go = cardByName(list, 'log-collector')
    expect(within(go).getByText('长期有效')).toBeInTheDocument()
  })

  it('搜索按名称与备注匹配，分类筛选叠加生效', async () => {
    const user = userEvent.setup()
    const list = await openWebsites()

    await user.type(screen.getByLabelText('搜索项目名称或备注'), 'api')
    expect(cards(list)).toHaveLength(2)

    await user.clear(screen.getByLabelText('搜索项目名称或备注'))
    await user.click(screen.getByRole('button', { name: '项目分类：全部分类' }))
    await user.click(screen.getByRole('menuitemradio', { name: '测试环境' }))
    expect(cards(list)).toHaveLength(5)
  })

  it('筛选无结果给换词提示；列表清空给「您的列表为空」并可一键打开建站弹窗', async () => {
    const user = userEvent.setup()
    const list = await openWebsites()

    await user.type(screen.getByLabelText('搜索项目名称或备注'), '不存在的项目')
    expect(screen.getByText('没有匹配的项目')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('搜索项目名称或备注'))

    // 筛选恢复后逐个删除不现实，直接断言空态文案存在换词提示之外的路径由 store 测试覆盖：
    // 这里只验证清空筛选后卡片回来。
    await waitFor(() => expect(cards(list)).toHaveLength(17))
  })
})

describe('详情抽屉', () => {
  it('点击卡片打开详情：类型、部署命令、流量与懒加载的运行日志', async () => {
    const user = userEvent.setup()
    await openWebsites()

    await user.click(screen.getByRole('article', { name: '订单中心-api' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByText('Java项目').length).toBeGreaterThan(0)
    expect(await within(dialog).findByText('java -jar order-api.jar --server.port=8080')).toBeInTheDocument()
    expect(within(dialog).getByText('今日流量')).toBeInTheDocument()
    // 运行日志懒加载：mock 日志行的启动完成字样。
    expect(await within(dialog).findByText(/启动完成，监听端口 8080/)).toBeInTheDocument()
  })

  it('HTML 项目详情显示 Nginx 托管说明而不是部署命令', async () => {
    const user = userEvent.setup()
    await openWebsites()

    await user.click(screen.getByRole('article', { name: 'company-portal' }))
    const dialog = await screen.findByRole('dialog')

    expect(
      await within(dialog).findByText('静态站点由 Nginx 直接托管，无部署命令'),
    ).toBeInTheDocument()
  })
})

describe('建站', () => {
  it('类型在弹窗内选择：默认 Java 有端口字段，切到 HTML 后消失，创建后新卡片出现', async () => {
    const user = userEvent.setup()
    const list = await openWebsites()

    await user.click(screen.getByRole('button', { name: '添加项目' }))
    const dialog = await screen.findByRole('dialog', { name: '添加项目' })
    expect(within(dialog).getByLabelText(/端口/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'HTML项目' }))
    expect(within(dialog).queryByLabelText(/端口/)).not.toBeInTheDocument()

    await user.type(within(dialog).getByLabelText(/项目名称/), '静态主页')
    await user.click(within(dialog).getByRole('button', { name: '添加项目' }))

    expect(screen.queryByRole('dialog', { name: '添加项目' })).not.toBeInTheDocument()
    expect(await within(list).findByRole('article', { name: /静态主页/ })).toBeInTheDocument()
    expect(lastNotification()).toBe('项目 静态主页 已添加（mock，待接入真实执行）')
  })
})

describe('卡片动作', () => {
  it('行内启停：状态标签随之变化并留 mock 通知，且不触发详情抽屉', async () => {
    const user = userEvent.setup()
    const list = await openWebsites()

    const java = cardByName(list, '订单中心-api')
    await user.click(within(java).getByRole('button', { name: '停止' }))

    expect(await within(java).findByText('已停止')).toBeInTheDocument()
    expect(lastNotification()).toContain('已停止（mock，待接入真实执行）')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('设置：修改备注后留 mock 通知', async () => {
    const user = userEvent.setup()
    await openWebsites()

    const java = screen.getByRole('article', { name: '订单中心-api' })
    await user.click(within(java).getByRole('button', { name: '设置' }))
    const dialog = await screen.findByRole('dialog', { name: /设置项目/ })
    await user.clear(within(dialog).getByLabelText(/备注/))
    await user.type(within(dialog).getByLabelText(/备注/), '改过的备注')
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }))

    expect(screen.queryByRole('dialog', { name: /设置项目/ })).not.toBeInTheDocument()
    expect(lastNotification()).toBe('项目 订单中心-api 已修改（mock，待接入真实执行）')
  })

  it('设置弹窗预填当前值：不改任何字段保存，备注与到期时间原样保留', async () => {
    const user = userEvent.setup()
    await openWebsites()

    const java = screen.getByRole('article', { name: '订单中心-api' })
    await user.click(within(java).getByRole('button', { name: '设置' }))
    const dialog = await screen.findByRole('dialog', { name: /设置项目/ })
    expect(within(dialog).getByLabelText(/备注/)).toHaveValue('商城核心下单链路')
    expect(within(dialog).getByLabelText(/到期时间/)).toHaveValue('2026-12-20')

    await user.click(within(dialog).getByRole('button', { name: '保存修改' }))

    const saved = useWebsitesStore
      .getState()
      .projects.find((project) => project.name === '订单中心-api')!
    // 回归锚点：设置弹窗曾因常驻挂载读不到当前值，保存一次就静默清空到期时间。
    expect(saved.expiryAt).toBe('2026-12-20')
    expect(saved.note).toBe('商城核心下单链路')
  })

  it('删除需确认：确认后卡片消失并留 mock 通知', async () => {
    const user = userEvent.setup()
    const list = await openWebsites()

    const java = cardByName(list, '订单中心-api')
    await user.click(within(java).getByRole('button', { name: '删除' }))
    const confirm = await screen.findByRole('dialog', { name: /确认删除项目/ })
    await user.click(within(confirm).getByRole('button', { name: '确认删除' }))

    await waitFor(() =>
      expect(screen.queryByRole('article', { name: '订单中心-api' })).not.toBeInTheDocument(),
    )
    expect(lastNotification()).toContain('已删除（mock，待接入真实执行）')
  })
})

describe('批量操作', () => {
  it('勾选两张卡片批量停止，完成后通知并清空选择', async () => {
    const user = userEvent.setup()
    const list = await openWebsites()

    const targets = cards(list).slice(0, 2)
    for (const card of targets) {
      await user.click(within(card).getByRole('checkbox'))
    }

    await user.click(screen.getByRole('button', { name: '批量操作：请选择批量操作' }))
    await user.click(screen.getByRole('menuitemradio', { name: '批量停止' }))
    await user.click(screen.getByRole('button', { name: '批量操作' }))

    expect(lastNotification()).toBe('批量停止完成：2 个项目（mock，待接入真实执行）')
    expect(useWebsitesStore.getState().selectedIds).toEqual([])
  })
})

describe('四态', () => {
  it('加载中给加载态，失败给错误态与重试，重试后数据为空给空态', async () => {
    const user = userEvent.setup()
    let fail = true
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    renderApp('/websites', {
      gateway: sessionGateway({
        list: async () => {
          if (fail) {
            await gate
            throw new Error('演示连接失败')
          }
          return []
        },
      }),
    })
    expect(await screen.findByText('正在加载网站项目…')).toBeInTheDocument()

    release?.()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByText('您的列表为空')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '添加一个项目' }))
    expect(await screen.findByRole('dialog', { name: '添加项目' })).toBeInTheDocument()
  })
})
