import type { EventStreamHandlers } from '@elysian/contracts'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockDataset } from '../../adapters/mock/dataset'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway, RunAdapter } from '../../contracts/adapters'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { renderApp } from '../../test/renderApp'

const dataset = createMockDataset()

function gatewayWithControllableStream() {
  const handlersRef: { current: EventStreamHandlers | undefined } = { current: undefined }
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const gateway: ElysianGateway = {
    ...base,
    events: {
      subscribe(handlers) {
        handlersRef.current = handlers
        handlers.onStatus('live')
        return () => {
          handlersRef.current = undefined
        }
      },
    },
  }
  return { gateway, handlersRef }
}

beforeEach(() => {
  useEventStreamStore.getState().disconnect()
  useEventStreamStore.setState({ status: 'connecting', recent: [], receivedCount: 0 })
})

describe('Agent 运行', () => {
  it('列出 13 个职责模块，其中 5 个有活跃运行', async () => {
    renderApp('/runs')
    const table = await screen.findByRole('table', { name: '职责模块' })
    const rows = within(table).getAllByRole('row').slice(1)

    expect(rows).toHaveLength(13)
    // 「执行中」在一行里会出现两次：Agent 状态与运行状态用的是同一个词，因此逐行统计。
    const running = rows.filter((row) => within(row).queryAllByText('执行中').length > 0)
    expect(running).toHaveLength(5)
    expect(screen.getByText(/当前 5 个模块有活跃运行/)).toBeInTheDocument()
  })

  it('模块行给出当前运行与关联事故，并可切换查看的那一次运行', async () => {
    const user = userEvent.setup()
    renderApp('/runs')
    const table = await screen.findByRole('table', { name: '职责模块' })
    const rows = within(table).getAllByRole('row').slice(1)

    const currentHeading = screen.getByRole('heading', { level: 2, name: /^运行 RUN-/ })
      .textContent

    // 挑一个「不是当前正在查看」的运行，这样切换才是可验证的
    const targetRow = rows.find((row) => {
      const code = within(row).queryByText(/^RUN-/)
      return code !== null && !currentHeading?.includes(code.textContent ?? '')
    })
    expect(targetRow).toBeDefined()

    const targetRunId = within(targetRow as HTMLElement).getByText(/^RUN-/).textContent ?? ''
    await user.click(within(targetRow as HTMLElement).getByRole('button', { name: '查看' }))

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: `运行 ${targetRunId}` })).toBeInTheDocument(),
    )
  })

  it('默认展示一次运行的时间线：轮次、步骤、模型请求与工具调用', async () => {
    renderApp('/runs')
    await screen.findByRole('table', { name: '职责模块' })

    // 默认选中等待审批的运行，它的等待原因必须显式呈现
    expect(await screen.findByText(/等待原因：/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: '轮次 1' })).toBeInTheDocument()
    // 多个步骤各有一条模型请求，因此用 getAllBy
    expect(screen.getAllByText(/模型请求 · /).length).toBeGreaterThan(0)
  })

  it('waiting-approval 的运行把等待原因写清楚，不写成「等待中」', async () => {
    const waiting = dataset.runs.find((run) => run.status === 'waiting-approval')
    expect(waiting).toBeDefined()

    renderApp(`/runs?run=${waiting?.id}`)
    await screen.findByRole('table', { name: '职责模块' })

    expect(await screen.findByText(`等待原因：${waiting?.waitingReason}`)).toBeInTheDocument()
    expect(screen.queryByText('等待中')).not.toBeInTheDocument()
  })

  it('可以从运行跳到关联事故与相关技能', async () => {
    const withIncident = dataset.runs.find((run) => run.incidentId !== undefined)
    expect(withIncident).toBeDefined()

    renderApp(`/runs?run=${withIncident?.id}`)
    await screen.findByRole('table', { name: '职责模块' })

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href') ?? '')
    expect(hrefs).toContain(`/incidents/${withIncident?.incidentId}`)
    expect(hrefs.some((href) => href.startsWith('/skills?capability='))).toBe(true)
  })

  it('失败运行显示错误信息与轮次结束原因', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const failedRun = {
      ...dataset.runs[0]!,
      id: 'RUN-FAILED-1',
      status: 'failed' as const,
      waitingReason: undefined,
      error: { message: '工具执行超时', endReason: 'error' as const },
    }
    // 注意：不能对类实例做对象展开，那会丢掉原型上的方法，这里显式实现整个接口。
    const runs: RunAdapter = {
      list: async () => [failedRun],
      find: async (runId) => (runId === failedRun.id ? failedRun : undefined),
      listModuleStatuses: async () => dataset.moduleStatuses,
    }

    renderApp('/runs', { gateway: { ...base, runs } })
    await screen.findByRole('table', { name: '职责模块' })

    expect(await screen.findByText(/运行失败：工具执行超时/)).toBeInTheDocument()
    expect(screen.getByText(/错误/)).toBeInTheDocument()
  })

  it('属于本次运行的实时事件会追加到时间线', async () => {
    const run = dataset.runs.find((candidate) => candidate.status === 'running')
    expect(run).toBeDefined()

    const { gateway, handlersRef } = gatewayWithControllableStream()
    renderApp(`/runs?run=${run?.id}`, { gateway })
    await screen.findByRole('table', { name: '职责模块' })
    expect(screen.getByText('暂时没有新的实时事件。')).toBeInTheDocument()

    act(() => {
      handlersRef.current?.onEvent({
        id: 'evt-run-1',
        name: 'tools/post-execute',
        at: '2026-09-12T23:59:00.000Z',
        payload: { runId: run?.id ?? '', toolName: 'logs.search', ok: true },
      })
    })

    await waitFor(() =>
      expect(screen.queryByText('暂时没有新的实时事件。')).not.toBeInTheDocument(),
    )
    expect(await screen.findByText('实时事件 tools/post-execute')).toBeInTheDocument()
  })

  it('读取失败时给出可重试的错误状态', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const runs: RunAdapter = {
      list: async () => {
        throw new Error('演示用的读取失败')
      },
      find: async () => undefined,
      listModuleStatuses: async () => dataset.moduleStatuses,
    }

    renderApp('/runs', { gateway: { ...base, runs } })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('演示用的读取失败')
    expect(within(alert).getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})
