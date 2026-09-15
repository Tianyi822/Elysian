import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useDatabaseStore } from '../../stores/databaseStore'
import { renderApp } from '../../test/renderApp'

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
  it('连接按钮打开会话：顶栏常驻演示标注与来源容器，提示符是实例名', async () => {
    const user = await openSession('MariaDB', 'MariaDB 数据库 mariadb-primary')

    const dialog = await screen.findByRole('dialog', { name: 'mariadb-primary SQL 会话' })
    // 演示标注常驻两处：顶栏徽章与会话首行横幅。
    expect(within(dialog).getAllByText('演示 SQL 会话 · 待接入真实执行')).toHaveLength(2)
    // 主体 = 实例名 · 来源容器名。
    expect(within(dialog).getByText('mariadb-primary · mariadb-primary')).toBeInTheDocument()

    const input = within(dialog).getByLabelText('SQL 输入')
    await user.type(input, 'help{Enter}')
    // 提示符是实例名，与提交的裸语句拼在同一行。
    expect(await within(dialog).findByText('mariadb-primary> help')).toBeInTheDocument()
  })

  it('SHOW TABLES 的结果按表格排版，末尾给行数；clear 清屏但保留横幅', async () => {
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
    // clear 截到横幅为止：横幅行仍在（徽章 + 首行各一份）。
    expect(within(dialog).getAllByText('演示 SQL 会话 · 待接入真实执行')).toHaveLength(2)
  })

  it('未知语句提示不在演示集内', async () => {
    const user = await openSession('MariaDB', 'MariaDB 数据库 mariadb-primary')
    const input = await screen.findByLabelText('SQL 输入')

    await user.type(input, 'DROP TABLE users{Enter}')

    const dialog = screen.getByRole('dialog', { name: 'mariadb-primary SQL 会话' })
    expect(
      await within(dialog).findByText('演示会话：该语句不在演示集内，输入 help 查看可用语句'),
    ).toBeInTheDocument()
    expect(within(dialog).getByText('mariadb-primary> DROP TABLE users')).toBeInTheDocument()
  })

  it('↑ 召回上一条语句；外部点击与 Esc 都不关闭，关闭要走确认，历史随会话清空', async () => {
    const user = await openSession('MariaDB', 'MariaDB 数据库 mariadb-primary')
    const input = await screen.findByLabelText('SQL 输入')
    const dialog = screen.getByRole('dialog', { name: 'mariadb-primary SQL 会话' })

    await user.type(input, 'SHOW TABLES{Enter}')
    await within(dialog).findByText('3 rows in set')
    await user.type(input, 'DESCRIBE users{Enter}')
    await within(dialog).findByText('mariadb-primary> DESCRIBE users')

    await user.type(input, '{ArrowUp}')
    expect(input).toHaveValue('DESCRIBE users')
    await user.type(input, '{ArrowUp}')
    expect(input).toHaveValue('SHOW TABLES')

    // 外部点击与 Esc 都不关闭终端。
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'mariadb-primary SQL 会话' })).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.getByRole('dialog', { name: 'mariadb-primary SQL 会话' })).toBeInTheDocument()

    // 关闭必须走确认：取消保留，确认才关。
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

    // 历史随会话清空：重开后 ↑ 不召回上一轮的语句。
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
