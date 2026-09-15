import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseInstance } from '@elysian/contracts'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useDatabaseStore } from '../../stores/databaseStore'
import { renderApp } from '../../test/renderApp'

const MARIADB: DatabaseInstance = {
  id: 'test-mariadb',
  engine: 'MariaDB',
  name: 'mariadb-test',
  host: 'mariadb-test.demo',
  port: 3306,
  version: '10.11.8',
  status: 'running',
  statusLabel: '运行中',
  storage: { usedGb: 12.5, totalGb: 32 },
  memory: { usedGb: 1.5, totalGb: 4 },
  connections: { active: 12, max: 100 },
  uptime: '1 天 2 小时',
  updatedAt: '2026-09-12T08:00:00.000Z',
}

beforeEach(() => {
  useDatabaseStore.setState({
    engine: 'MariaDB',
    status: 'idle',
    databases: [],
    errorMessage: undefined,
  })
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
  it('以卡片呈现 MariaDB 的状态与资源指标', async () => {
    renderApp('/databases', { gateway: pageGateway({ list: async () => [MARIADB] }) })

    const list = await screen.findByRole('list', { name: 'MariaDB 数据库列表' })
    const card = within(list).getByRole('article', { name: 'MariaDB 数据库 mariadb-test' })
    expect(card).toHaveTextContent('MariaDB · 10.11.8')
    expect(card).toHaveTextContent('mariadb-test.demo:3306')
    expect(card).toHaveTextContent('容量12.5 / 32 GB')
    expect(card).toHaveTextContent('内存占用1.5 / 4 GB')
    expect(card).toHaveTextContent('连接数12 / 100')
    expect(card).toHaveTextContent('运行中')
    expect(within(card).getByLabelText('MariaDB 图标')).toBeInTheDocument()
  })

  it('切换到 MySQL 后展示 MySQL 卡片，切换到未接入类型显示空态', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway() })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })

    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'MySQL' }))
    expect(await screen.findByRole('list', { name: 'MySQL 数据库列表' })).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'MySQL 数据库 mysql-orders' })).toHaveTextContent('连接偏高')

    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Redis' }))
    expect(await screen.findByText('暂未接入 Redis')).toBeInTheDocument()
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
    expect(await screen.findByText('暂未接入 MariaDB')).toBeInTheDocument()
  })
})

