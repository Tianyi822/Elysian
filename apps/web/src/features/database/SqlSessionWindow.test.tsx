import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ElysianGateway } from '../../contracts/adapters'
import { DATABASE_INSTANCES } from '../../adapters/mock/databaseData'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useDatabaseStore } from '../../stores/databaseStore'
import { renderApp } from '../../test/renderApp'
import { completeSqlStatement } from './SqlSessionWindow'

/**
 * 演示会话窗口的端到端行为：卡片「连接」开窗、语句经 mock 引擎求值、
 * 历史召回与关闭确认由终端内核承载。数据走默认 mock 数据集，
 * 因此目录表与卡片连接数都是真实取值，不另造假数据。
 */

function sessionGateway(): ElysianGateway {
  return createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
}

async function openSession(engine: 'MariaDB' | 'Redis', cardName: string) {
  const user = userEvent.setup()
  renderApp('/databases', { gateway: sessionGateway() })
  await screen.findByRole('list', { name: 'MariaDB 数据库列表' })
  if (engine !== 'MariaDB') {
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: engine }))
  }
  const card = await screen.findByRole('article', { name: cardName })
  await user.click(within(card).getByRole('button', { name: '连接' }))
  return user
}

beforeEach(() => {
  useDatabaseStore.setState({
    engine: 'MariaDB',
    status: 'idle',
    databases: [],
    containers: [],
    images: [],
    errorMessage: undefined,
    session: undefined,
  })
})

describe('数据库演示会话窗口', () => {
  it('连接按钮打开会话：顶栏常驻演示标注，日志区不重复一行，提示符是实例名', async () => {
    const user = await openSession('MariaDB', 'MariaDB 数据库 mariadb-primary')

    const dialog = await screen.findByRole('dialog', { name: 'mariadb-primary SQL 会话' })
    // 演示标注只在顶栏徽章一处；日志区从空开始，不与徽章重复。
    expect(within(dialog).getAllByText('演示 SQL 会话 · 待接入真实执行')).toHaveLength(1)
    // 主体 = 实例名；来源容器与实例同名时不重复一遍。
    expect(within(dialog).getByText('mariadb-primary')).toBeInTheDocument()
    expect(within(dialog).queryByText('mariadb-primary · mariadb-primary')).not.toBeInTheDocument()

    const input = within(dialog).getByLabelText('SQL 输入')
    await user.type(input, 'help{Enter}')
    // 提示符是实例名，与提交的裸语句拼在同一行。
    expect(await within(dialog).findByText('mariadb-primary> help')).toBeInTheDocument()
  })

  it('SHOW TABLES 的结果按表格排版，末尾给行数；clear 清空日志、顶栏标注仍在', async () => {
    const user = await openSession('MariaDB', 'MariaDB 数据库 mariadb-primary')
    const input = await screen.findByLabelText('SQL 输入')

    await user.type(input, 'SHOW TABLES{Enter}')

    const dialog = screen.getByRole('dialog', { name: 'mariadb-primary SQL 会话' })
    await waitFor(() => expect(dialog).toHaveTextContent('3 rows in set'))
    expect(dialog).toHaveTextContent('| Tables_in_mariadb-primary |')
    expect(dialog).toHaveTextContent('| users |')
    expect(dialog).toHaveTextContent('| orders |')
    expect(dialog).toHaveTextContent('| sessions |')
    expect(dialog).toHaveTextContent('mariadb-primary> SHOW TABLES')

    await user.type(input, 'clear{Enter}')
    await waitFor(() =>
      expect(within(dialog).queryByText('3 rows in set')).not.toBeInTheDocument(),
    )
    // 日志清空，但演示标注仍由顶栏徽章常驻。
    expect(within(dialog).getAllByText('演示 SQL 会话 · 待接入真实执行')).toHaveLength(1)
  })

  it('关闭要走确认，历史随会话清空：重开后 ↑ 不召回上一轮的语句', async () => {
    const user = await openSession('MariaDB', 'MariaDB 数据库 mariadb-primary')
    const input = await screen.findByLabelText('SQL 输入')
    const dialog = screen.getByRole('dialog', { name: 'mariadb-primary SQL 会话' })

    await user.type(input, 'SHOW TABLES{Enter}')
    await within(dialog).findByText('3 rows in set')

    await user.click(within(dialog).getByRole('button', { name: '关闭会话' }))
    const confirm = await screen.findByRole('dialog', { name: '确认关闭会话？' })
    expect(confirm.textContent).toContain('未执行的语句将丢失')
    await user.click(within(confirm).getByRole('button', { name: '继续使用' }))
    expect(screen.getByRole('dialog', { name: 'mariadb-primary SQL 会话' })).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '关闭会话' }))
    await user.click(await screen.findByRole('button', { name: '确认关闭' }))
    expect(
      screen.queryByRole('dialog', { name: 'mariadb-primary SQL 会话' }),
    ).not.toBeInTheDocument()

    const card = screen.getByRole('article', { name: 'MariaDB 数据库 mariadb-primary' })
    await user.click(within(card).getByRole('button', { name: '连接' }))
    const freshInput = await screen.findByLabelText('SQL 输入')
    await user.type(freshInput, '{ArrowUp}')
    expect(freshInput).toHaveValue('')
  })

  it('Redis 会话的 INFO clients 与卡片连接数同源', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: sessionGateway() })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Redis' }))
    // 会话弹窗打开后 Radix 会把外部内容标记为 aria-hidden，卡片断言要先做。
    const card = await screen.findByRole('article', { name: 'Redis 数据库 redis-cache' })
    expect(card).toHaveTextContent('连接数34 / 512')

    await user.click(within(card).getByRole('button', { name: '连接' }))
    const input = await screen.findByLabelText('SQL 输入')
    await user.type(input, 'INFO clients{Enter}')

    const dialog = screen.getByRole('dialog', { name: 'redis-cache SQL 会话' })
    await waitFor(() => expect(dialog).toHaveTextContent('1 row in set'))
    expect(dialog).toHaveTextContent('connected_clients')
    expect(dialog).toHaveTextContent('| 34 |')
  })
})

describe('SQL Tab 补全', () => {
  const mariadb = DATABASE_INSTANCES.find((database) => database.id === 'db-mariadb-primary')!
  const redis = DATABASE_INSTANCES.find((database) => database.id === 'db-redis-cache')!

  it('行首唯一命中语句：补齐并补一个空格', () => {
    expect(completeSqlStatement(mariadb, 'hel', 3)).toEqual({ draft: 'help ', cursor: 5 })
  })

  it('行首多命中收敛到最长公共前缀：SH 补成 SHOW（含空格）', () => {
    // 'SHOW TABLES' 与 "SHOW STATUS LIKE 'Threads_connected'" 同时命中，
    // 不可唯一补全，收敛到公共前缀 'SHOW '——末尾空格保留。
    expect(completeSqlStatement(mariadb, 'SH', 2)).toEqual({ draft: 'SHOW ', cursor: 5 })
  })

  it('行中补目录表名：FROM 后的前缀补齐为表名并补空格', () => {
    expect(completeSqlStatement(mariadb, 'SELECT * FROM us', 16)).toEqual({
      draft: 'SELECT * FROM users ',
      cursor: 20,
    })
  })

  it('Redis 行中补键名', () => {
    expect(completeSqlStatement(redis, 'GET s', 5)).toEqual({
      draft: 'GET session:1001 ',
      cursor: 17,
    })
  })

  it('公共前缀不比草稿长时草稿不动，候选列成清单', () => {
    // DESCRIBE 后按 Tab：users、orders、sessions 无公共前缀可收敛，全部列为候选。
    const result = completeSqlStatement(mariadb, 'DESCRIBE ', 9)
    expect(result.draft).toBe('DESCRIBE ')
    expect(result.cursor).toBe(9)
    expect(result.candidates).toEqual(['users', 'orders', 'sessions'])
  })

  it('没有命中时原样返回，不带候选', () => {
    expect(completeSqlStatement(mariadb, 'DROP', 4)).toEqual({ draft: 'DROP', cursor: 4 })
    expect(completeSqlStatement(mariadb, 'DROP', 4).candidates).toBeUndefined()
  })
})
