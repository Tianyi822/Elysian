import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { SEED_LOGIN_LOGS } from '../../adapters/mock/logsData'
import type { ElysianGateway } from '../../contracts/adapters'
import { formatLoginTime } from '../../components/format'
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
}

beforeEach(() => {
  useLoginLogStore.setState(INITIAL_STATE)
  useLogsStore.setState({ tab: 'runtime' })
})

async function openLoginTab() {
  const user = userEvent.setup()
  await screen.findByRole('group', { name: '日志页签' })
  await user.click(within(screen.getByRole('banner')).getByRole('button', { name: '平台登录日志' }))
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
        loginLogs: async () => [],
      },
    }
    renderApp('/logs', { gateway })
    await openLoginTab()

    expect(await screen.findByText('还没有登录日志')).toBeInTheDocument()
  })
})
