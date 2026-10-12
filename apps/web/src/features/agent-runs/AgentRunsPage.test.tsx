import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import * as Tooltip from '@radix-ui/react-tooltip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '../../app/theme/ThemeProvider'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { RUNTIME_TOOL_NAMES } from '@elysian/contracts'
import { createMockGateway } from '../../adapters/mock/gateway'
import { AgentRunsMockAdapter, resetAgentRunsData } from '../../adapters/mock/agent/agentRunsMockAdapter'
import type { ElysianGateway } from '../../contracts/adapters'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { useAgentRunsStore } from '../../stores/agentRunsStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { AgentRunsPage } from './AgentRunsPage'
import { RequireArea } from '../../app/RequireArea'

/*
 * 运行记录页组件集成测试：经 MemoryRouter 只挂 /agent/runs 一条路由渲染
 * AgentRunsPage（不经过共享 router.tsx，避免其他模块在途页面的导入链影响
 * 本模块测试；路由注册本身由冻结的 router.test.tsx 覆盖）。
 * 覆盖验收面：运行时报告卡（能力位/限额）、内核不可用整页态、status 单值
 * 过滤（深链 + 文本精确过滤 + URL 契约）、分页游标、详情事件流与调用保真
 * （argumentsJson 原文）、取消三态语义、interrupted 不重跑、批次表单白名单
 * 与提交后回读推进、无权限分支。轮询节奏本身由 useSilentPolling 的地基测试覆盖，
 * 这里用「服务端推进 + 手动刷新（与轮询同一 refreshRun 回读路径）」做确定性断言。
 */

function renderRunsApp(path: string, gateway: ElysianGateway) {
  const router = createMemoryRouter([{
    path: '/agent/runs',
    element: (
      <RequireArea area="agent" title="运行记录">
        <AgentRunsPage />
      </RequireArea>
    ),
  }], { initialEntries: [path] })
  const view = render(
    <ThemeProvider>
      <Tooltip.Provider delayDuration={0}>
        <GatewayProvider gateway={gateway}>
          <RouterProvider router={router} />
        </GatewayProvider>
      </Tooltip.Provider>
    </ThemeProvider>,
  )
  return { ...view, router }
}

type RunsSpy = { listRuns: ReturnType<typeof vi.fn>; submitBatch: ReturnType<typeof vi.fn>; cancelRun: ReturnType<typeof vi.fn> }

function runsGateway(options?: {
  runtime?: ElysianGateway['agentRuns']['runtime']
  listLimit?: number
  denyArea?: boolean
}): { gateway: ElysianGateway; spy: RunsSpy } {
  const base = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
  const adapter = new AgentRunsMockAdapter()
  const spy: RunsSpy = {
    listRuns: vi.fn((query?: never, signal?: AbortSignal) =>
      adapter.listRuns(options?.listLimit === undefined ? query : { ...(query ?? {}), limit: options.listLimit }, signal)),
    submitBatch: vi.fn((input: never) => adapter.submitBatch(input)),
    cancelRun: vi.fn((runId: string) => adapter.cancelRun(runId)),
  }
  const agentRuns: ElysianGateway['agentRuns'] = {
    runtime: options?.runtime === undefined ? (signal?: AbortSignal) => base.agentRuns.runtime(signal) : options.runtime,
    submitBatch: spy.submitBatch as unknown as ElysianGateway['agentRuns']['submitBatch'],
    listRuns: spy.listRuns as unknown as ElysianGateway['agentRuns']['listRuns'],
    getRun: (runId, signal?) => adapter.getRun(runId, signal),
    listRunCalls: (runId, query?, signal?) => adapter.listRunCalls(runId, query, signal),
    listRunEvents: (runId, query?, signal?) => adapter.listRunEvents(runId, query, signal),
    cancelRun: spy.cancelRun as unknown as ElysianGateway['agentRuns']['cancelRun'],
  }
  const gateway: ElysianGateway = { ...base, agentRuns }
  if (options?.denyArea === true) {
    const session = base.session
    return {
      gateway: {
        ...gateway,
        session: {
          canView: async (area: Parameters<typeof session.canView>[0]) => area !== 'agent',
          status: (returnTo?: string, opts?: { passive?: boolean }) => session.status(returnTo, opts),
          login: (username: string, password: string) => session.login(username, password),
          logout: () => session.logout(),
          listSessions: () => session.listSessions(),
          changePassword: (input: never) => session.changePassword(input),
          logoutOtherSessions: () => session.logoutOtherSessions(),
        },
      },
      spy,
    }
  }
  return { gateway, spy }
}

beforeEach(() => {
  vi.useRealTimers()
  resetAgentRunsData()
  useAgentRunsStore.getState().reset()
  useAgentRuntimeStore.getState().reset()
  useNotificationStore.getState().clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('运行时报告卡', () => {
  it('available:true 时展示能力位与限额', async () => {
    const { gateway } = runsGateway()
    renderRunsApp('/agent/runs', gateway)
    const card = await screen.findByRole('region', { name: '运行时能力报告' })
    for (const label of ['批次通道', 'Agent 会话', '技能', 'MCP', '容器执行', '审批', '工作流（v1）', '长期记忆', '向量索引', '工作流（v2）', '资源锁', '执行器运行时']) {
      expect(within(card).getByText(label)).toBeInTheDocument()
    }
    // 12 个能力位 + 内核状态读数，共 13 个「可用」。
    expect(within(card).getAllByText('可用').length).toBe(13)
    expect(within(card).getByText('并发')).toBeInTheDocument()
    expect(within(card).getByText('记录保留')).toBeInTheDocument()
  })

  it('available:false 时整页 AgentUnavailableState 与服务端 reason，不再渲染列表', async () => {
    const { gateway } = runsGateway({
      runtime: async () => {
        const info = await new AgentRunsMockAdapter().runtime()
        return { ...info, available: false, reason: '本地演示模式：未启用任务运行内核' }
      },
    })
    renderRunsApp('/agent/runs', gateway)
    expect(await screen.findByText('Agent 内核不可用')).toBeInTheDocument()
    expect(screen.getByText('本地演示模式：未启用任务运行内核')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Run 列表' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '批次任务提交' })).not.toBeInTheDocument()
  })
})

describe('Run 列表', () => {
  it('渲染种子行：状态标签、驱动版本与类型', async () => {
    const { gateway } = runsGateway()
    renderRunsApp('/agent/runs', gateway)
    const region = await screen.findByRole('region', { name: 'Run 列表' })
    await waitFor(() => {
      expect(within(region).getByText('run-batch-ok')).toBeInTheDocument()
    })
    expect(within(region).getAllByText('已成功').length).toBeGreaterThan(0)
    expect(within(region).getAllByText('v1').length).toBeGreaterThan(0)
    expect(within(region).getAllByText('v2').length).toBeGreaterThan(0)
    expect(within(region).getAllByText('批次').length).toBeGreaterThan(0)
    expect(within(region).getAllByText('Agent').length).toBeGreaterThan(0)
  })

  it('深链 status 单值过滤：请求与 URL 都只携带一个 status 参数', async () => {
    const { gateway, spy } = runsGateway()
    const view = renderRunsApp('/agent/runs?status=succeeded', gateway)
    await waitFor(() => {
      expect(spy.listRuns).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }), undefined)
    })
    for (const call of spy.listRuns.mock.calls) {
      const query = call[0] as Record<string, unknown> | undefined
      expect(query === undefined || query.status === undefined || query.status === 'succeeded').toBe(true)
    }
    expect(view.router.state.location.search).toBe('?status=succeeded')
    expect((view.router.state.location.search.match(/status=/g) ?? []).length).toBe(1)
  })

  it('requestId 精确文本过滤命中唯一 Run', async () => {
    const { gateway, spy } = runsGateway()
    renderRunsApp('/agent/runs', gateway)
    const input = await screen.findByLabelText('requestId（精确）')
    fireEvent.change(input, { target: { value: 'req-agent-live' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))
    await waitFor(() => {
      expect(spy.listRuns).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'req-agent-live' }), undefined)
    })
    const region = screen.getByRole('region', { name: 'Run 列表' })
    await waitFor(() => {
      expect(within(region).getByText('run-agent-live')).toBeInTheDocument()
      expect(within(region).queryByText('run-batch-ok')).not.toBeInTheDocument()
    })
  })

  it('分页翻页：游标保持十进制字符串（2^53 级不截断）', async () => {
    const { gateway, spy } = runsGateway({ listLimit: 6 })
    renderRunsApp('/agent/runs', gateway)
    await screen.findByText('run-batch-ok')
    fireEvent.click(screen.getByRole('button', { name: '加载更多 Run' }))
    await screen.findByText('run-agent-interrupted')
    const cursors = spy.listRuns.mock.calls
      .map((call) => (call[0] as { cursor?: string } | undefined)?.cursor)
      .filter((value): value is string => value !== undefined)
    expect(cursors).toContain('9007199254740995')
    expect(String(BigInt(cursors[cursors.length - 1] ?? '0'))).toMatch(/^(0|[1-9][0-9]*)$/)
  })
})

describe('Run 详情', () => {
  it('深链详情：状态卡、事件流 seq 递增、调用原文与用量未知', async () => {
    const { gateway } = runsGateway()
    renderRunsApp('/agent/runs?runId=run-agent-live', gateway)
    expect(await screen.findByRole('region', { name: 'Run 状态' })).toBeInTheDocument()
    expect(screen.getAllByText('执行中').length).toBeGreaterThan(0)
    expect(screen.getByText(/phase：推理中/)).toBeInTheDocument()
    const events = screen.getByRole('region', { name: 'Run 事件流' })
    await waitFor(() => {
      expect(within(events).getByText('6')).toBeInTheDocument()
    })
    const seqs = within(events).getAllByText(/^[0-9]+$/).map((node) => node.textContent ?? '')
    expect(seqs).toEqual(['1', '2', '3', '4', '5', '6'])
    const calls = screen.getByRole('region', { name: 'Run 工具调用' })
    expect(within(calls).getByText('skill.exec.read_log')).toBeInTheDocument()
    // argumentsJson 服务端原文逐字呈现，不做 parse/stringify 往返。
    expect(within(calls).getByText(/\{"path":"\/var\/log\/nginx\/error\.log","tail":200,"sinceMinutes":30\}/)).toBeInTheDocument()
    const usage = screen.getByRole('region', { name: '用量与限额' })
    // 供应商未报告 actualTokens/cachedTokens：显示「未知」，不补零。
    expect(within(usage).getAllByText('未知').length).toBeGreaterThanOrEqual(2)
  })

  it('queued Run 取消立即显示已取消', async () => {
    const { gateway, spy } = runsGateway()
    renderRunsApp('/agent/runs?runId=run-batch-queued', gateway)
    await screen.findByRole('region', { name: 'Run 状态' })
    fireEvent.click(screen.getByRole('button', { name: '取消该 Run' }))
    await waitFor(() => {
      expect(spy.cancelRun).toHaveBeenCalledWith('run-batch-queued')
    })
    expect(await screen.findByText('已取消')).toBeInTheDocument()
    expect(screen.getByText(/裁决为已取消/)).toBeInTheDocument()
  })

  it('running Run 取消先显示已请求取消，回读终态裁决', async () => {
    const { gateway } = runsGateway()
    renderRunsApp('/agent/runs?runId=run-agent-live', gateway)
    await screen.findByRole('region', { name: 'Run 状态' })
    fireEvent.click(screen.getByRole('button', { name: '取消该 Run' }))
    expect(await screen.findByText(/已请求取消（等待执行停止）/)).toBeInTheDocument()
    expect(screen.getAllByText('执行中').length).toBeGreaterThan(0)
    // 服务端侧取消宽限后的推进（真实路径为 3 秒轮询触发同一 refreshRun 回读）。
    await new AgentRunsMockAdapter().getRun('run-agent-live')
    fireEvent.click(screen.getByRole('button', { name: '刷新 Run 详情' }))
    expect(await screen.findByText('已取消')).toBeInTheDocument()
  })

  it('终态 Run 不提供取消按钮；interrupted 显示原因且无任何重试按钮', async () => {
    const { gateway } = runsGateway()
    renderRunsApp('/agent/runs?runId=run-batch-ok', gateway)
    await screen.findByRole('region', { name: 'Run 状态' })
    expect(screen.queryByRole('button', { name: '取消该 Run' })).not.toBeInTheDocument()
    expect(screen.getByText(/Run 已到终态，取消按钮不可用/)).toBeInTheDocument()

    const interrupted = runsGateway()
    renderRunsApp('/agent/runs?runId=run-agent-interrupted', interrupted.gateway)
    expect((await screen.findAllByText(/panel-restarted/)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/不会自动重跑/).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /重试/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '取消该 Run' })).not.toBeInTheDocument()
  })
})

describe('批次任务表单', () => {
  it('下拉只出现四条白名单工具，与 RUNTIME_TOOL_NAMES 一致', async () => {
    const { gateway } = runsGateway()
    renderRunsApp('/agent/runs', gateway)
    const trigger = await screen.findByLabelText('第 1 步工具')
    await userEvent.setup().click(trigger)
    const options = screen.getAllByRole('menuitemradio')
    expect(options.map((option) => option.textContent)).toEqual([...RUNTIME_TOOL_NAMES])
  })

  it('提交后跳详情并推进至终态：requestId 只提交一次（刷新不重放）', async () => {
    const { gateway, spy } = runsGateway()
    const view = renderRunsApp('/agent/runs', gateway)
    await screen.findByRole('button', { name: '提交批次任务并查看' })
    fireEvent.click(screen.getByRole('button', { name: '提交批次任务并查看' }))
    // 202 受理后跳转详情（?runId=），首轮回读已进入 running。
    await screen.findByRole('region', { name: 'Run 状态' })
    expect(view.router.state.location.search).toContain('runId=run-mock-1')
    expect(screen.getAllByText('执行中').length).toBeGreaterThan(0)
    // 服务端逐步骤推进（真实路径为 3 秒轮询触发同一 refreshRun 回读）。
    const adapter = new AgentRunsMockAdapter()
    for (let tick = 0; tick < 4; tick += 1) {
      await adapter.getRun('run-mock-1')
    }
    fireEvent.click(screen.getByRole('button', { name: '刷新 Run 详情' }))
    expect((await screen.findAllByText('已成功')).length).toBeGreaterThan(0)
    const calls = screen.getByRole('region', { name: 'Run 工具调用' })
    expect(within(calls).getByText('docker_containers_list')).toBeInTheDocument()
    // 提交只发生一次：requestId 幂等键存活于组件实例内存，轮询绝不重放提交。
    expect(spy.submitBatch).toHaveBeenCalledTimes(1)
    const submittedInput = spy.submitBatch.mock.calls[0]?.[0] as { requestId: string; kind: string }
    expect(submittedInput.kind).toBe('tool-batch')
    expect(submittedInput.requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    // 终态后再回读一次，提交次数仍为 1。
    fireEvent.click(screen.getByRole('button', { name: '刷新 Run 详情' }))
    await waitFor(() => {
      expect(screen.getAllByText('已成功').length).toBeGreaterThan(0)
    })
    expect(spy.submitBatch).toHaveBeenCalledTimes(1)
  })

  it('重复提交同一内容：幂等回读原 Run，不产生第二个 Run', async () => {
    const adapter = new AgentRunsMockAdapter()
    const { gateway, spy } = runsGateway()
    const before = await adapter.listRuns({})
    renderRunsApp('/agent/runs', gateway)
    await screen.findByRole('region', { name: '批次任务提交' })
    fireEvent.click(screen.getByRole('button', { name: '提交批次任务并查看' }))
    await screen.findByRole('region', { name: 'Run 状态' })
    // 同 requestId 同步骤再提交一次：服务端口径幂等回读原 Run，不产生第二个。
    const submitted = spy.submitBatch.mock.calls[0]?.[0] as {
      requestId: string; kind: 'tool-batch'; steps: readonly { tool: 'docker_containers_list'; args: Record<string, never> }[]
    }
    const again = await adapter.submitBatch(submitted)
    const mine = await adapter.listRuns({ requestId: submitted.requestId })
    expect(mine.items).toHaveLength(1)
    expect(again.id).toBe(mine.items[0]?.id)
    fireEvent.click(screen.getByRole('button', { name: '返回运行列表' }))
    const after = await adapter.listRuns({})
    expect(after.items.length).toBe(before.items.length + 1)
  })
})

describe('无权限分支', () => {
  it('canView=false 时由 RequireArea 呈现 NoPermissionState', async () => {
    const { gateway } = runsGateway({ denyArea: true })
    renderRunsApp('/agent/runs', gateway)
    expect(await screen.findByText(/无权限查看/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Run 列表' })).not.toBeInTheDocument()
  })
})
