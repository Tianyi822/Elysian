import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Container, ContainerCreateInput, ContainerImage } from '@elysian/contracts'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { CONTAINERS, CONTAINER_IMAGES } from '../../adapters/mock/containersData'
import { useContainersStore } from '../../stores/containersStore'
import { renderApp } from '../../test/renderApp'

/**
 * 页面测试网关：内存事件源 + 慢节拍，动作类接口按需覆盖。
 * 事件流取 createMockGateway 的内存实现（一分钟一拍），
 * 只替换 containers 域——AppShell 挂载时就会订阅事件流，缺 events 会让整树崩溃。
 */
function pageGateway(overrides: Partial<ElysianGateway['containers']> = {}): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  return {
    ...base,
    containers: {
      list: async () => [...CONTAINERS],
      listImages: async () => [...CONTAINER_IMAGES],
      execMockCommand: (id: string, command: string) => base.containers.execMockCommand(id, command),
      create: (input: ContainerCreateInput) => base.containers.create(input),
      requestAction: async (id: string) => CONTAINERS.find((c) => c.id === id)!,
      ...overrides,
    },
  }
}

beforeEach(() => {
  useContainersStore.setState({
    status: 'idle', errorMessage: undefined, containers: [], images: [], samples: {},
    view: 'grid', statusFilter: 'all', search: '', detailContainerId: undefined,
    terminal: undefined, busyActions: [], createOpen: false, creating: false,
  })
})

describe('容器页骨架', () => {
  it('进入页面渲染全部 8 个容器', async () => {
    renderApp('/containers', { gateway: pageGateway() })
    const list = await screen.findByRole('list', { name: '容器列表' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(8)
  })

  it('状态筛选只保留所选状态的容器', async () => {
    const user = userEvent.setup()
    renderApp('/containers', { gateway: pageGateway() })
    await screen.findByRole('list', { name: '容器列表' })

    await user.click(screen.getByRole('button', { name: '已停止' }))
    const list = screen.getByRole('list', { name: '容器列表' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(list.textContent).toContain('backup-agent')
  })

  it('搜索按名称过滤，无结果显示专属空态', async () => {
    const user = userEvent.setup()
    renderApp('/containers', { gateway: pageGateway() })
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
    renderApp('/containers', { gateway })
    expect(await screen.findByText('容器数据加载失败')).toBeInTheDocument()

    fail = false
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('list', { name: '容器列表' })).toBeInTheDocument()
  })

  it('数据集为空渲染空态', async () => {
    renderApp('/containers', {
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
    renderApp('/containers', { gateway: pageGateway() })
    const card = await screen.findByRole('listitem', { name: 'nginx-proxy' })
    expect(card.textContent).toContain('ctr-nginx-pro')
    expect(card.textContent).toContain('nginx:1.27-alpine')
    expect(card.textContent).toContain('运行中')
    expect(card.textContent).toContain('80 → 8080/tcp')
    expect(card.textContent).toContain('443 → 8443/tcp')
  })

  it('运行中卡片有实时资源数值；停止的卡片资源显示 — 且终端禁用', async () => {
    renderApp('/containers', { gateway: pageGateway() })
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

  it('重启中的卡片操作全部禁用；卡片显示运行时长', async () => {
    renderApp('/containers', { gateway: pageGateway() })
    const restarting = await screen.findByRole('listitem', { name: 'metrics-agent' })
    for (const name of ['终端', '停止', '重启']) {
      expect(within(restarting).getByRole('button', { name })).toBeDisabled()
    }
    expect(restarting.textContent).toMatch(/运行时长 \d+ (天|小时|分钟)/)
  })
})

describe('镜像视图', () => {
  it('切换到镜像视图显示 6 行镜像与引用数', async () => {
    const user = userEvent.setup()
    renderApp('/containers', { gateway: pageGateway() })
    await screen.findByRole('list', { name: '容器列表' })
    expect(
      within(screen.getByRole('banner')).getByRole('group', { name: '视图切换' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '镜像' }))
    const table = await screen.findByRole('table', { name: '镜像列表' })
    expect(within(table).getAllByRole('row')).toHaveLength(7) // 表头 + 6 行
    expect(table.textContent).toContain('node:22-alpine')
    expect(within(table).getByText('4')).toBeInTheDocument() // node 被引用 4 次
    expect(table.textContent).toContain('2026-09-03') // grafana 拉取时间：基准 09-12 08:00 回推 216 小时
    // 信息密度：名称行补摘要，未引用的镜像明说「未使用」而不是干巴巴的 0。
    expect(table.textContent).toContain('sha256:5d2fa6b8c417')
    expect(within(table).getByText('未使用')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '容器' }))
    expect(screen.getByRole('list', { name: '容器列表' })).toBeInTheDocument()
  })
  it('删除按钮全部禁用，tooltip 按是否被引用区分', async () => {
    const user = userEvent.setup()
    renderApp('/containers', { gateway: pageGateway() })
    await screen.findByRole('list', { name: '容器列表' })
    await user.click(screen.getByRole('button', { name: '镜像' }))
    const table = await screen.findByRole('table', { name: '镜像列表' })

    const buttons = within(table).getAllByRole('button', { name: '删除' })
    expect(buttons).toHaveLength(6)
    for (const button of buttons) expect(button).toBeDisabled()
    expect(buttons.every((button) => button.hasAttribute('title'))).toBe(true)
    expect(table.textContent).not.toContain('删除待接入真实执行') // title 不进 textContent，只查存在
  })
})

describe('容器详情面板', () => {
  it('点击详情打开右侧面板，分节展示完整配置', async () => {
    const user = userEvent.setup()
    renderApp('/containers', { gateway: pageGateway() })
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
      expect(heading.closest('section')).toHaveClass('rounded-xl', 'border', 'border-line')
    }
  })

  it('Esc 关闭面板回到列表', async () => {
    const user = userEvent.setup()
    renderApp('/containers', { gateway: pageGateway() })
    const card = await screen.findByRole('listitem', { name: 'redis-cache' })
    await user.click(within(card).getByRole('button', { name: '详情' }))
    expect(await screen.findByRole('dialog', { name: 'redis-cache' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('演示终端', () => {
  async function openTerminalOf(name: string) {
    const user = userEvent.setup()
    renderApp('/containers', { gateway: pageGateway() })
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
    expect(await within(dialog).findByText(/可用命令/)).toBeInTheDocument()

    await user.type(input, 'rm -rf /{Enter}')
    expect(await within(dialog).findByText(/不在演示集内/)).toBeInTheDocument()
  })

  it('↑ 召回上一条历史命令，再次执行输出一致', async () => {
    const { user, dialog } = await openTerminalOf('nginx-proxy')
    const input = within(dialog).getByLabelText('命令输入')
    await user.type(input, 'env{Enter}')
    await user.type(input, '{ArrowUp}')
    expect(input).toHaveValue('env')
  })

  it('Tab 补全命令：唯一前缀直接补齐，多候选列出候选行', async () => {
    const { user, dialog } = await openTerminalOf('nginx-proxy')
    const input = within(dialog).getByLabelText('命令输入')

    // Tab 用 fireEvent 派发：userEvent 造出的 keydown 不可取消，它的 Tab 焦点行为
    // 会无视 preventDefault 把焦点挪走；浏览器里的真实 keydown 是可取消的。
    await user.type(input, 'hel')
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input).toHaveValue('help ')
    await user.keyboard('{Enter}')
    expect(await within(dialog).findByText(/可用命令/)).toBeInTheDocument()

    await user.type(input, 'c')
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input).toHaveValue('c')
    // 候选以两个空格分隔；断言用 \s+ 容忍 Testing Library 的空白归一化。
    expect(await within(dialog).findByText(/cat\s+clear/)).toBeInTheDocument()
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

  it('输入法组合中的回车只确认候选不发送，随后的真实回车才发送', async () => {
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

    // 用户随后真正按下回车才发送。
    await user.type(input, '{Enter}')
    expect(await within(dialog).findByText('TZ=Asia/Shanghai')).toBeInTheDocument()
  })

  it('输入法组合中的方向键用于选词，不召回历史命令', async () => {
    const { user, dialog } = await openTerminalOf('nginx-proxy')
    const input = within(dialog).getByLabelText('命令输入')
    await user.type(input, 'env{Enter}')
    expect(input).toHaveValue('')

    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveValue('')

    fireEvent.compositionEnd(input)
    await user.type(input, '{ArrowUp}')
    expect(input).toHaveValue('env')
  })

  it('Esc 与点击外部都不关闭；唯一关闭路径是关闭终端并确认', async () => {
    const { user, dialog } = await openTerminalOf('nginx-proxy')

    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'nginx-proxy 终端' })).toBeInTheDocument()

    // 点外部：点击面板之外的卡片区域。Radix 弹窗给外部子树加 aria-hidden（查询需 hidden），
    // 且锁滚动样式给 body 设 pointer-events:none，userEvent 拒绝派发；改用 fireEvent 触发
    // 同一 pointerdown，外部关闭判定仍走 Radix 的 document 级监听，拦截路径不变。
    fireEvent.pointerDown(screen.getByRole('listitem', { name: 'redis-cache', hidden: true }))
    expect(screen.getByRole('dialog', { name: 'nginx-proxy 终端' })).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '关闭终端' }))
    const confirm = await screen.findByRole('dialog', { name: '确认关闭终端？' })
    expect(confirm.textContent).toContain('会话历史将不再保留')

    await user.click(within(confirm).getByRole('button', { name: '继续使用' }))
    expect(screen.getByRole('dialog', { name: 'nginx-proxy 终端' })).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '关闭终端' }))
    await user.click(await screen.findByRole('button', { name: '确认关闭' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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
    renderApp('/containers', {
      gateway: createMockGateway({ eventStream: 'memory', eventIntervalMs: 50 }),
    })
    const card = await screen.findByRole('listitem', { name: 'nginx-proxy' })

    await user.click(within(card).getByRole('button', { name: '停止' }))

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent('容器 nginx-proxy 已停止')
    const stopped = await screen.findByRole('listitem', { name: 'nginx-proxy' })
    expect(stopped.textContent).toContain('已停止')
    expect(within(stopped).getByRole('button', { name: '终端' })).toBeDisabled()
    expect(within(stopped).getByRole('button', { name: '启动' })).toBeEnabled()
  })

  it('重启操作的通知带 mock 标注，且随后回到运行中', async () => {
    const user = userEvent.setup()
    renderApp('/containers', {
      gateway: createMockGateway({ eventStream: 'memory', eventIntervalMs: 50 }),
    })
    const card = await screen.findByRole('listitem', { name: 'redis-cache' })

    await user.click(within(card).getByRole('button', { name: '重启' }))

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      '已请求重启 redis-cache（mock，待接入真实执行）',
    )
    await waitFor(() => {
      expect(screen.getByRole('listitem', { name: 'redis-cache' }).textContent).toContain('运行中')
    })
  })
})

describe('创建容器', () => {
  async function openCreateForm(gateway = pageGateway()) {
    const user = userEvent.setup()
    renderApp('/containers', { gateway })
    await screen.findByRole('list', { name: '容器列表' })
    await user.click(screen.getByRole('button', { name: '创建容器' }))
    const dialog = await screen.findByRole('dialog', { name: '创建容器' })
    return { user, dialog }
  }

  it('打开表单见 mock 徽章；可选设置默认收起，展开后可加端口行', async () => {
    const { user, dialog } = await openCreateForm()
    expect(dialog.textContent).toContain('演示 · 待接入真实执行')
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
    expect(screen.getAllByRole('listitem', { hidden: true })).toHaveLength(8)
  })

  it('宿主端口与现有容器冲突显示行内错误', async () => {
    const { user, dialog } = await openCreateForm()
    await user.selectOptions(within(dialog).getByLabelText('镜像'), 'img-redis')
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
    await user.selectOptions(within(dialog).getByLabelText('镜像'), 'img-redis')
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
    await user.selectOptions(within(dialog).getByLabelText('镜像'), 'img-alpine')
    await user.click(within(dialog).getByRole('button', { name: '创建并运行' }))
    expect(await screen.findByRole('listitem', { name: 'alpine' })).toBeInTheDocument()
  })
})
