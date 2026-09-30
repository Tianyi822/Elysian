import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { SEED_LOGIN_LOGS } from '../../adapters/mock/logsData'
import type { ElysianGateway } from '../../contracts/adapters'
import { formatLoginTime } from '../../components/format'
import { resolveViewTab, writeStoredViewTab } from '../../app/theme/themePreferences'
import { useLoginLogStore } from '../../stores/loginLogStore'
import { useLogsStore } from '../../stores/logsStore'
import { renderApp } from '../../test/renderApp'

/**
 * 平台登录日志面板：经 renderApp('/logs') 走真实路由与顶栏页签打开，
 * 数据走默认 mock 种子；时间期望值用与组件相同的 formatter 计算，机器时区无关。
 */

const INITIAL_STATE = {
  status: 'idle' as const,
  errorMessage: undefined,
  entries: [],
  truncated: false,
  skippedLines: 0,
  skippedFiles: 0,
  statusFilter: 'all' as const,
  search: '',
}

beforeEach(() => {
  useLoginLogStore.setState(INITIAL_STATE)
  useLogsStore.setState({ tab: 'runtime' })
})

async function openLoginTab() {
  const user = userEvent.setup()
  await screen.findByRole('group', { name: '日志页签' })
  await user.click(within(screen.getByRole('banner')).getByRole('button', { name: '登录日志' }))
}

/** 状态筛选按钮（在顶栏下方的筛选组里，避免与表格内的状态标签同名混淆）。 */
function statusFilterButton(name: string) {
  return within(screen.getByRole('group', { name: '登录状态筛选' })).getByRole('button', { name })
}

/** 表格数据行。 */
function loginRows(table: HTMLElement): HTMLElement[] {
  return within(table).getAllByRole('row').slice(1)
}

/** 按断言口径从种子推导数量，不硬编码。 */
function seedCount(predicate: (entry: (typeof SEED_LOGIN_LOGS)[number]) => boolean): number {
  return SEED_LOGIN_LOGS.filter(predicate).length
}

describe('平台登录日志面板', () => {
  it('列出全部登录记录：IP 与归属地分列，状态与时间正确', async () => {
    renderApp('/logs')
    await openLoginTab()

    const table = within(await screen.findByRole('region', { name: '登录日志表' })).getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'IP 地址',
      '归属地',
      '用户代理',
      '登录状态',
      '时间',
    ])

    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(SEED_LOGIN_LOGS.length)

    const first = SEED_LOGIN_LOGS[0]!
    const cells = within(rows[0] as HTMLElement).getAllByRole('cell')
    expect(cells[0]).toHaveTextContent(first.ip)
    expect(cells[1]).toHaveTextContent(first.location)
    expect(cells[2]).toHaveTextContent('Chrome/152.0.0.0')
    expect(cells[3]).toHaveTextContent('登录成功')
    expect(cells[4]).toHaveTextContent(formatLoginTime(first.time))

    // 失败登录以文字标签呈现，不只靠颜色；存在至少一条供演示。
    expect(within(table).getAllByText('登录失败').length).toBeGreaterThan(0)
  })

  it('加载失败时给出错误态与重试，重试成功后内容出现', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    let calls = 0
    const gateway: ElysianGateway = {
      ...base,
      logs: {
        runtimeLog: () => base.logs.runtimeLog(),
        operationLogs: () => base.logs.operationLogs(),
        clearLogs: (category) => base.logs.clearLogs(category),
        loginLogs: () => {
          calls += 1
          if (calls === 1) throw new Error('演示用的读取失败')
          return base.logs.loginLogs()
        },
      },
    }
    renderApp('/logs', { gateway })
    await openLoginTab()

    expect(await screen.findByRole('alert')).toHaveTextContent('演示用的读取失败')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('region', { name: '登录日志表' })).toBeInTheDocument()
  })

  it('空数据时给出空状态', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const gateway: ElysianGateway = {
      ...base,
      logs: {
        runtimeLog: () => base.logs.runtimeLog(),
        operationLogs: () => base.logs.operationLogs(),
        clearLogs: (category) => base.logs.clearLogs(category),
        loginLogs: async () => ({ entries: [], truncated: false, skippedLines: 0, skippedFiles: 0 }),
      },
    }
    renderApp('/logs', { gateway })
    await openLoginTab()

    expect(await screen.findByText('还没有登录日志')).toBeInTheDocument()
  })

  it('状态筛选：只显示所选结果的记录，全部恢复全量', async () => {
    const user = userEvent.setup()
    renderApp('/logs')
    await openLoginTab()
    const table = within(await screen.findByRole('region', { name: '登录日志表' })).getByRole('table')

    await user.click(statusFilterButton('登录失败'))
    const failureCount = seedCount((entry) => entry.status === 'failure')
    expect(failureCount).toBeGreaterThan(0)
    expect(loginRows(table)).toHaveLength(failureCount)
    expect(within(table).getAllByText('登录失败')).toHaveLength(failureCount)
    expect(within(table).queryByText('登录成功')).not.toBeInTheDocument()
    expect(statusFilterButton('登录失败')).toHaveAttribute('aria-pressed', 'true')

    await user.click(statusFilterButton('全部'))
    expect(loginRows(table)).toHaveLength(SEED_LOGIN_LOGS.length)
    expect(statusFilterButton('全部')).toHaveAttribute('aria-pressed', 'true')
  })

  it('搜索按 IP 与用户代理匹配，可与状态筛选叠加', async () => {
    const user = userEvent.setup()
    renderApp('/logs')
    await openLoginTab()
    const table = within(await screen.findByRole('region', { name: '登录日志表' })).getByRole('table')
    const searchBox = screen.getByLabelText('搜索登录日志')

    await user.type(searchBox, '114.135')
    expect(loginRows(table)).toHaveLength(seedCount((entry) => entry.ip.includes('114.135')))

    await user.clear(searchBox)
    await user.type(searchBox, 'Safari')
    expect(loginRows(table)).toHaveLength(seedCount((entry) => entry.userAgent.includes('Safari')))

    await user.click(statusFilterButton('登录失败'))
    expect(loginRows(table)).toHaveLength(
      seedCount((entry) => entry.userAgent.includes('Safari') && entry.status === 'failure'),
    )
  })

  it('宿主机演示态在筛选栏标注「演示数据」', async () => {
    renderApp('/logs')
    await openLoginTab()
    await screen.findByRole('region', { name: '登录日志表' })
    expect(screen.getByRole('status')).toHaveTextContent('演示数据')
  })

  it('筛选与搜索无匹配时给出表内空提示', async () => {
    const user = userEvent.setup()
    renderApp('/logs')
    await openLoginTab()
    const table = within(await screen.findByRole('region', { name: '登录日志表' })).getByRole('table')

    await user.type(screen.getByLabelText('搜索登录日志'), '绝不存在的关键字')
    expect(within(table).getByText('没有匹配的登录记录，换个关键词或清空筛选')).toBeInTheDocument()
  })

  it('刷新后仍停在上次的日志页签', async () => {
    writeStoredViewTab(window.localStorage, 'logs', 'login')
    useLogsStore.setState({
      tab: resolveViewTab(window.localStorage, 'logs', ['runtime', 'login'] as const, 'runtime'),
    })

    renderApp('/logs')

    expect(await screen.findByRole('region', { name: '登录日志表' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('banner')).getByRole('button', { name: '登录日志' }),
    ).toHaveAttribute('aria-pressed', 'true')
  })
})
