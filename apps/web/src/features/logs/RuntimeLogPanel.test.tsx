import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { getRuntimeLog } from '../../adapters/mock/logsData'
import type { ElysianGateway } from '../../contracts/adapters'
import { formatByteSize } from '../../components/format'
import { useLogsStore } from '../../stores/logsStore'
import { useRuntimeLogStore } from '../../stores/runtimeLogStore'
import { renderApp } from '../../test/renderApp'
import { logLineToneClass } from './RuntimeLogPanel'

/**
 * 平台运行日志面板：默认页签，renderApp('/logs') 直达。
 * 行级断言都从 getRuntimeLog() 的确定性内容推出来，不硬编码行文本。
 */

const INITIAL_STATE = {
  status: 'idle' as const,
  errorMessage: undefined,
  snapshot: undefined,
  search: '',
  follow: true,
  fullscreen: false,
  refreshing: false,
}

beforeEach(() => {
  useRuntimeLogStore.setState(INITIAL_STATE)
  useLogsStore.setState({ tab: 'runtime' })
})

function logView(): HTMLElement {
  return screen.getByRole('log', { name: '平台运行日志' })
}

function linesContaining(keyword: string): number {
  return getRuntimeLog()
    .content.split('\n')
    .filter((line) => line.includes(keyword)).length
}

describe('日志行着色', () => {
  it('按级别映射语义令牌：两主题下对比度都由令牌保证', () => {
    expect(logLineToneClass('x [ERROR] 连接失败')).toBe('text-danger')
    expect(logLineToneClass('x [WARNING] 检测到慢查询')).toBe('text-warning')
    expect(logLineToneClass('x [DEBUG] 轮询公告列表')).toBe('text-fg-muted')
    expect(logLineToneClass('x [INFO] 采集完成')).toBe('text-fg')
  })
})

describe('平台运行日志面板', () => {
  it('加载后渲染整份日志，并展示日志大小', async () => {
    renderApp('/logs')

    expect(await screen.findAllByText(/get_announcement_list/)).toHaveLength(
      linesContaining('get_announcement_list'),
    )
    expect(
      within(logView()).getAllByText(/docker\.py:stats_poll/),
    ).toHaveLength(linesContaining('docker.py:stats_poll'))
    expect(screen.getByText(formatByteSize(getRuntimeLog().sizeBytes))).toBeInTheDocument()
  })

  it('搜索按行过滤，无匹配时给出空提示', async () => {
    const user = userEvent.setup()
    renderApp('/logs')
    await screen.findAllByText(/get_announcement_list/)

    await user.type(screen.getByLabelText('搜索日志关键字'), '慢查询')
    expect(within(logView()).getAllByText(/慢查询/)).toHaveLength(linesContaining('慢查询'))

    await user.type(screen.getByLabelText('搜索日志关键字'), '绝不存在的关键字')
    expect(within(logView()).getByText('没有匹配的日志行')).toBeInTheDocument()
  })

  it('滑动日志是开关：默认开，点击关闭', async () => {
    const user = userEvent.setup()
    renderApp('/logs')
    await screen.findAllByText(/get_announcement_list/)

    const followButton = screen.getByRole('button', { name: '滑动日志' })
    expect(followButton).toHaveAttribute('aria-pressed', 'true')
    await user.click(followButton)
    expect(followButton).toHaveAttribute('aria-pressed', 'false')
  })

  it('全屏展示可打开，弹窗内退出', async () => {
    const user = userEvent.setup()
    renderApp('/logs')
    await screen.findAllByText(/get_announcement_list/)

    await user.click(screen.getByRole('button', { name: '全屏展示' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('log', { name: '平台运行日志' })).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '退出全屏' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('刷新日志会重新读取数据源', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    let calls = 0
    const gateway: ElysianGateway = {
      ...base,
      logs: {
        runtimeLog: () => {
          calls += 1
          return base.logs.runtimeLog()
        },
        loginLogs: () => base.logs.loginLogs(),
      },
    }
    const user = userEvent.setup()
    renderApp('/logs', { gateway })
    await screen.findAllByText(/get_announcement_list/)
    expect(calls).toBe(1)

    // 分步等每一次刷新真正落定：load 在 refreshing 期间拒绝并发，不能假设两次点击排队执行。
    await user.click(screen.getByRole('button', { name: '刷新日志' }))
    await waitFor(() => expect(calls).toBe(2))
    await user.click(screen.getByRole('button', { name: '刷新日志' }))
    await waitFor(() => expect(calls).toBe(3))
    expect(screen.getByRole('button', { name: '刷新日志' })).toBeEnabled()
  })

  it('加载失败时给出错误态，重试成功后内容出现', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    let calls = 0
    const gateway: ElysianGateway = {
      ...base,
      logs: {
        runtimeLog: () => {
          calls += 1
          if (calls === 1) throw new Error('演示用的读取失败')
          return base.logs.runtimeLog()
        },
        loginLogs: () => base.logs.loginLogs(),
      },
    }
    const user = userEvent.setup()
    renderApp('/logs', { gateway })

    expect(await screen.findByRole('alert')).toHaveTextContent('演示用的读取失败')
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('log', { name: '平台运行日志' })).toBeInTheDocument()
  })
})
