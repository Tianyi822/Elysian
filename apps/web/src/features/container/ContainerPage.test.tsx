import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Container, ContainerImage } from '@elysian/contracts'
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
  return {
    ...createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' }),
    containers: {
      list: async () => [...CONTAINERS],
      listImages: async () => [...CONTAINER_IMAGES],
      execMockCommand: async () => ({ lines: [] }),
      requestAction: async (id: string) => CONTAINERS.find((c) => c.id === id)!,
      ...overrides,
    },
  }
}

beforeEach(() => {
  useContainersStore.setState({
    status: 'idle', errorMessage: undefined, containers: [], images: [], samples: {},
    view: 'grid', statusFilter: 'all', search: '', detailContainerId: undefined,
    terminal: undefined, busyActions: [],
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

    await user.click(screen.getByRole('button', { name: '镜像' }))
    const table = await screen.findByRole('table', { name: '镜像列表' })
    expect(within(table).getAllByRole('row')).toHaveLength(7) // 表头 + 6 行
    expect(table.textContent).toContain('node:22-alpine')
    expect(within(table).getByText('4')).toBeInTheDocument() // node 被引用 4 次
    expect(table.textContent).toContain('2026-09-03') // grafana 拉取时间：基准 09-12 08:00 回推 216 小时

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
