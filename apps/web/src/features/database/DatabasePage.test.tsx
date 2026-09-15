import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseInstance } from '@elysian/contracts'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useContainersStore } from '../../stores/containersStore'
import { useDatabaseStore } from '../../stores/databaseStore'
import { renderApp } from '../../test/renderApp'

const MARIADB: DatabaseInstance = {
  id: 'test-mariadb',
  engine: 'MariaDB',
  name: 'mariadb-test',
  version: '10.11.8',
  status: 'running',
  containerId: 'ctr-mariadb-primary',
  credentials: { username: 'ops', password: 'demo-mariadb-7f2c' },
  storage: { usedGb: 12.5, totalGb: 32 },
  memory: { usedGb: 1.5, totalGb: 4 },
  connections: { active: 12, max: 100 },
  updatedAt: '2026-09-12T08:00:00.000Z',
}

beforeEach(() => {
  useDatabaseStore.setState({
    engine: 'MariaDB',
    status: 'idle',
    databases: [],
    containers: [],
    images: [],
    errorMessage: undefined,
  })
  useContainersStore.setState({ view: 'grid', detailContainerId: undefined })
})

function pageGateway(overrides: Partial<ElysianGateway['databases']> = {}): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  return {
    ...base,
    databases: {
      list: () => base.databases.list(),
      ...overrides,
    },
  }
}

describe('数据库页面', () => {
  it('以卡片呈现 MariaDB 的状态、资源指标与来源容器', async () => {
    renderApp('/databases', { gateway: pageGateway({ list: async () => [MARIADB] }) })

    const list = await screen.findByRole('list', { name: 'MariaDB 数据库列表' })
    const card = within(list).getByRole('article', { name: 'MariaDB 数据库 mariadb-test' })
    expect(card).toHaveTextContent('MariaDB · 10.11.8')
    expect(card).toHaveTextContent('来源容器')
    expect(card).toHaveTextContent('mariadb-primary')
    expect(card).toHaveTextContent('mariadb:10.11')
    expect(card).toHaveTextContent('容量12.5 / 32 GB')
    expect(card).toHaveTextContent('内存占用1.5 / 4 GB')
    expect(card).toHaveTextContent('连接数12 / 100')
    expect(card).toHaveTextContent('运行中')
    expect(within(card).getByLabelText('MariaDB 图标')).toBeInTheDocument()

    // 地址行已删：卡片不再出现域名、IP 或端口字样。
    expect(card).not.toHaveTextContent(/\.demo|:\d{4}/)
    // 副标题说明段已删，「N 个实例」计数保留。
    expect(screen.queryByText(/数据来自本地演示集/)).not.toBeInTheDocument()
    expect(screen.getByText('1 个实例')).toBeInTheDocument()
  })

  it('切换到 MySQL 后展示 MySQL 卡片，切换到无实例类型显示空态', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway() })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })

    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'MySQL' }))
    expect(await screen.findByRole('list', { name: 'MySQL 数据库列表' })).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'MySQL 数据库 mysql-orders' })).toHaveTextContent('连接偏高')

    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'MongoDB' }))
    expect(await screen.findByText('这台机器上没有 MongoDB 的数据库容器')).toBeInTheDocument()
  })

  it('点击来源容器行跳到容器页并打开对应详情面板', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/databases', { gateway: pageGateway() })
    const list = await screen.findByRole('list', { name: 'MariaDB 数据库列表' })

    await user.click(within(list).getByRole('button', { name: /来源容器/ }))

    expect(router.state.location.pathname).toBe('/containers')
    expect(await screen.findByRole('dialog', { name: 'mariadb-primary' })).toBeInTheDocument()
  })

  it('adapter 读取失败显示错误态，重试成功后恢复卡片', async () => {
    const user = userEvent.setup()
    let failed = true
    const gateway = pageGateway({
      list: async () => {
        if (failed) throw new Error('演示数据库连接失败')
        return [MARIADB]
      },
    })
    renderApp('/databases', { gateway })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('演示数据库连接失败')
    failed = false
    await user.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('article', { name: 'MariaDB 数据库 mariadb-test' })).toBeInTheDocument()
  })

  it('adapter 返回空数据时显示空态', async () => {
    renderApp('/databases', { gateway: pageGateway({ list: async () => [] }) })
    expect(await screen.findByText('这台机器上没有 MariaDB 的数据库容器')).toBeInTheDocument()
  })
})
