import { act, fireEvent, render, screen, within } from '@testing-library/react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentModelProfile, RuntimeRun } from '@elysian/contracts'
import type { ElysianGateway } from '../../contracts/adapters'
import { AgentWorkbenchMockAdapter, resetAgentWorkbenchData } from '../../adapters/mock/agent/agentWorkbenchMockAdapter'
import { workbenchInternals } from '../../adapters/mock/agent/agentWorkbenchData'
import { createMockGateway } from '../../adapters/mock/gateway'
import { ThemeProvider } from '../../app/theme/ThemeProvider'
import { NotificationHost } from '../../components/NotificationHost'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { useAgentWorkbenchStore } from '../../stores/agentWorkbenchStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { AgentWorkbenchPage } from './AgentWorkbenchPage'

/*
 * 工作台页面闭环：三栏与种子、新建任务（requestId 单飞）→ 轮询推进 → 续轮
 * runNumber 递增、busy 禁用与服务端文案、waiting-approval 深链、取消语义、
 * 工作记忆与长期记忆分域、工作区写入/预览与隔离标记、连接中断提示。
 * 轮询推进统一 fake timers + advancePoll（agentTestUtils 口径）。
 */

function workbenchGateway(options: { failGetSessionAfter?: number } = {}) {
  const adapter = new AgentWorkbenchMockAdapter()
  const spy = {
    createTask: vi.spyOn(adapter, 'createTask'),
    continueRun: vi.spyOn(adapter, 'continueRun'),
    createSession: vi.spyOn(adapter, 'createSession'),
    writeWorkspaceFile: vi.spyOn(adapter, 'writeWorkspaceFile'),
    cancelRun: vi.fn(async (runId: string): Promise<RuntimeRun> => workbenchInternals.requestCancel(runId)),
  }
  if (options.failGetSessionAfter !== undefined) {
    let calls = 0
    const original = adapter.getSession.bind(adapter)
    vi.spyOn(adapter, 'getSession').mockImplementation(async (sessionId: string) => {
      calls += 1
      if (calls > (options.failGetSessionAfter ?? 0)) throw new Error('Agent 请求网络失败')
      return original(sessionId)
    })
  }
  const base = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
  const gateway: ElysianGateway = {
    ...base,
    agentWorkbench: adapter,
    // 类方法在原型上，不能靠 spread 继承：显式保留 runtime，替换 cancelRun。
    agentRuns: {
      runtime: (signal?: AbortSignal) => base.agentRuns.runtime(signal),
      submitBatch: (input) => base.agentRuns.submitBatch(input),
      listRuns: (query, signal) => base.agentRuns.listRuns(query, signal),
      getRun: (runId, signal) => base.agentRuns.getRun(runId, signal),
      listRunCalls: (runId, query, signal) => base.agentRuns.listRunCalls(runId, query, signal),
      listRunEvents: (runId, query, signal) => base.agentRuns.listRunEvents(runId, query, signal),
      cancelRun: spy.cancelRun,
    },
  }
  return { gateway, spy }
}

function renderWorkbench(path = '/agent', gateway: ElysianGateway) {
  const router = createMemoryRouter([{ path: '/agent', element: <AgentWorkbenchPage /> }], { initialEntries: [path] })
  const view = render(
    <ThemeProvider>
      <Tooltip.Provider delayDuration={0}>
        <GatewayProvider gateway={gateway}>
          <NotificationHost />
          <RouterProvider router={router} />
        </GatewayProvider>
      </Tooltip.Provider>
    </ThemeProvider>,
  )
  return { ...view, router }
}


/** 初始加载链（runtime→会话→深链→任务/消息）分多跳微任务，逐轮 flush 到稳定。 */
async function settle(rounds = 25): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  }
}

async function selectSessionByName(name: RegExp): Promise<void> {
  const sessions = screen.getByRole('region', { name: 'Ely 会话列表' })
  const row = within(sessions).getByRole('button', { name })
  fireEvent.click(row)
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-10T08:00:00Z'))
  resetAgentWorkbenchData(new Date())
  useAgentRuntimeStore.getState().reset()
  useAgentWorkbenchStore.getState().reset()
  useNotificationStore.getState().clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('三栏与种子数据', () => {
  it('左栏列会话（busy 徽标与 lastSeq），主区展示任务与公开消息流', async () => {
    const { gateway } = workbenchGateway()
    renderWorkbench('/agent', gateway)
    await settle()

    const sessions = screen.getByRole('region', { name: 'Ely 会话列表' })
    expect(within(sessions).getByRole('button', { name: /容器巡检演示/ })).toBeInTheDocument()
    expect(within(sessions).getByRole('button', { name: /等待审批的演示会话/ })).toBeInTheDocument()
    expect(within(sessions).getByText('运行中')).toBeInTheDocument()
    expect(within(sessions).getAllByText(/^seq \d+$/).length).toBe(2)

    // 显式选择种子会话：任务条与消息流就绪。
    await selectSessionByName(/容器巡检演示/)
    const main = screen.getByRole('region', { name: '会话任务' })
    expect(within(main).getByRole('tab', { name: /检查容器运行状态/ })).toBeInTheDocument()
    expect(within(main).getAllByText('已成功').length).toBeGreaterThanOrEqual(1)
    expect(within(main).getByText('#1')).toBeInTheDocument()
    expect(within(main).getByText('#2')).toBeInTheDocument()
    expect(within(main).getAllByText('用户').length).toBe(2)
    expect(within(main).getAllByText('Ely').length).toBe(2)
  })

  it('quarantined 消息渲染隔离标记且不展开内容；wikiSources 引用展示', async () => {
    const { gateway } = workbenchGateway()
    renderWorkbench('/agent', gateway)
    await settle()
    await selectSessionByName(/容器巡检演示/)
    expect(screen.getByText('#1')).toBeInTheDocument()
    expect(screen.getByText('来源已撤回，内容已隔离：该答复引用了不可信或未核实内容，正文不再展示。')).toBeInTheDocument()
    expect(screen.queryByText('（该答复引用的来源已失效，内容不再展示。）')).not.toBeInTheDocument()
    expect(screen.getByText(/引用：wiki-page-1（修订 1）/)).toBeInTheDocument()
  })

  it('详情面板五页签可达；工作记忆与长期记忆文案分域', async () => {
    const { gateway } = workbenchGateway()
    renderWorkbench('/agent', gateway)
    await settle()
    const detail = screen.getByRole('region', { name: '任务详情面板' })
    // 未选任务时空态。
    expect(within(detail).getByText('未选择任务')).toBeInTheDocument()
    fireEvent.click(within(detail).getByRole('tab', { name: '工作记忆' }))
    expect(within(detail).getByText('未选择任务')).toBeInTheDocument()

    // 选中任务后切页签。
    await selectSessionByName(/容器巡检演示/)
    fireEvent.click(screen.getByRole('tab', { name: /检查容器运行状态/ }))
    await settle()
      expect(screen.getByText(/任务目标：检查容器运行状态/)).toBeInTheDocument()
    fireEvent.click(within(detail).getByRole('tab', { name: '工作记忆' }))
    await settle()
    expect(within(detail).getByText('任务工作记忆')).toBeInTheDocument()
    expect(within(detail).getByText(/跨任务的长期知识在/)).toBeInTheDocument()
    expect(within(detail).getByRole('link', { name: '长期记忆' })).toHaveAttribute('href', '/agent/memory')
    expect(within(detail).getByText(/事实（附证据引用）/)).toBeInTheDocument()
  })
})

describe('任务闭环', () => {
  it('新建任务单飞提交、提示 Run 编号，轮询推进至成功后可续轮（runNumber 递增）', async () => {
    const { gateway, spy } = workbenchGateway()
    renderWorkbench('/agent', gateway)
    await settle()
    await selectSessionByName(/容器巡检演示/)
    expect(screen.getByText('#1')).toBeInTheDocument()

    const input = screen.getByLabelText('新任务输入')
    fireEvent.change(input, { target: { value: '页面闭环：检查防火墙规则' } })
    const submit = screen.getByRole('button', { name: '创建并运行' })
    fireEvent.click(submit)
    // 连点只发一次：requestId 幂等键存活于组件实例，第二次点击被单飞锁挡下。
    fireEvent.click(submit)
    await settle()

    expect(spy.createTask).toHaveBeenCalledTimes(1)
    const submitted = spy.createTask.mock.calls[0] as unknown as [string, { requestId: string; content: string }]
    expect(submitted[1].content).toBe('页面闭环：检查防火墙规则')
    expect(submitted[1].requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    await settle()
    expect(screen.getByText(/已受理：第 1 轮运行（新任务）/)).toBeInTheDocument()

    // 选中任务：输入区切到续轮形态。
    await settle()
    expect(screen.getByText(/任务目标：页面闭环：检查防火墙规则/)).toBeInTheDocument()
    const continueInput = screen.getByLabelText('继续任务输入')
    expect(continueInput).toBeDisabled()
    expect(screen.getByText(/会话有进行中的运行/)).toBeInTheDocument()

    // 轮询推进：3 秒一拍，6.5 秒后成功并出现答复。
    for (let tick = 0; tick < 4; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    }
    await settle()
      expect(screen.getByText(/已完成「页面闭环：检查防火墙规则」/)).toBeInTheDocument()

    // 终态后输入解禁，续轮 runNumber 递增。
    await settle()
      expect(screen.getByLabelText('继续任务输入')).toBeEnabled()
    fireEvent.change(screen.getByLabelText('继续任务输入'), { target: { value: '补充：核对 UFW 规则' } })
    fireEvent.click(screen.getByRole('button', { name: '继续任务' }))
    await settle()
    expect(spy.continueRun).toHaveBeenCalledTimes(1)
    await settle()
    expect(screen.getByText(/已受理：第 2 轮运行（续轮）/)).toBeInTheDocument()
    for (let tick = 0; tick < 4; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    }
    await settle()
      expect(screen.getByText(/已完成「补充：核对 UFW 规则」/)).toBeInTheDocument()
  })

  it('运行页签展示状态/用量/限额与取消按钮；未知用量显示未报告', async () => {
    const { gateway, spy } = workbenchGateway()
    renderWorkbench('/agent', gateway)
    await settle()
    await selectSessionByName(/容器巡检演示/)
    fireEvent.click(screen.getByRole('tab', { name: /检查容器运行状态/ }))
    const detail = screen.getByRole('region', { name: '任务详情面板' })
    await settle()
      expect(screen.getByText(/任务目标：检查容器运行状态/)).toBeInTheDocument()
    expect(within(detail).getAllByText('已成功').length).toBeGreaterThanOrEqual(1)
    expect(within(detail).getAllByText('未报告').length).toBeGreaterThanOrEqual(1)
    // 终态任务不提供取消。
    expect(within(detail).queryByRole('button', { name: '取消运行' })).not.toBeInTheDocument()

    // 新建任务进入排队：取消经 gateway.agentRuns 接缝，排队即取消。
    fireEvent.click(screen.getByRole('tab', { name: '新建任务' }))
    fireEvent.change(screen.getByLabelText('新任务输入'), { target: { value: '排队后取消' } })
    fireEvent.click(screen.getByRole('button', { name: '创建并运行' }))
    await settle()
    await settle()
    const cancel = within(detail).getByRole('button', { name: '取消运行' })
    fireEvent.click(cancel)
    await settle()
      expect(spy.cancelRun).toHaveBeenCalledTimes(1)
    await settle()
      expect(within(detail).getByText('已取消')).toBeInTheDocument()
  })
})

describe('busy 会话', () => {
  it('等待审批会话：输入/会话设置禁用并给原因，审批深链与取消语义正确', async () => {
    const { gateway, spy } = workbenchGateway()
    renderWorkbench('/agent', gateway)
    await settle()
    await selectSessionByName(/等待审批的演示会话/)
    fireEvent.click(screen.getByRole('tab', { name: /演练等待审批状态/ }))
    await settle()

    const main = screen.getByRole('region', { name: '会话任务' })
    await settle()
      expect(within(main).getByText(/会话有进行中的运行/)).toBeInTheDocument()
    expect(within(main).getByLabelText('继续任务输入')).toBeDisabled()
    expect(within(main).getByRole('button', { name: '会话设置' })).toBeDisabled()

    // 运行页签：等待审批给出审批中心深链。
    const detail = screen.getByRole('region', { name: '任务详情面板' })
    fireEvent.click(within(detail).getByRole('tab', { name: '运行' }))
    await settle()
    const approvalLink = within(detail).getByRole('link', { name: '去审批中心' })
    expect(approvalLink).toHaveAttribute('href', '/agent/approvals?tab=approvals&runId=run-3')

    fireEvent.click(within(detail).getByRole('tab', { name: '工作区' }))
    await settle()
    expect(within(detail).getByText(/工作区写入与删除在运行结束前被服务端拒绝/)).toBeInTheDocument()
    expect(within(detail).getByRole('button', { name: '写入文件' })).toBeDisabled()
    fireEvent.click(within(detail).getByRole('tab', { name: '运行' }))

    // 等待审批取消立即终止：取消后会话空闲、输入解禁。
    await settle()
    fireEvent.click(within(detail).getByRole('button', { name: '取消运行' }))
    await settle()
      expect(spy.cancelRun).toHaveBeenCalledWith('run-3')
    await settle()
      expect(within(main).getByLabelText('继续任务输入')).toBeEnabled()

  })
})

describe('工作区', () => {
  it('写入新文件提交原始字节；预览回读内容一致；种子隔离版本标注', async () => {
    const { gateway, spy } = workbenchGateway()
    renderWorkbench('/agent', gateway)
    await settle()
    await selectSessionByName(/容器巡检演示/)
    fireEvent.click(screen.getByRole('tab', { name: /检查容器运行状态/ }))
    const detail = screen.getByRole('region', { name: '任务详情面板' })
    await settle()
      expect(screen.getByText(/任务目标：检查容器运行状态/)).toBeInTheDocument()
    fireEvent.click(within(detail).getByRole('tab', { name: '工作区' }))
    await settle()
    expect(within(detail).getByText('notes/summary.md')).toBeInTheDocument()

    await settle()
    fireEvent.change(within(detail).getByLabelText('路径'), { target: { value: 'evidence/page.md' } })
    fireEvent.change(within(detail).getByLabelText(/内容（按 UTF-8 提交原始字节）/), { target: { value: '# 页面写入\n中文内容\n' } })
    fireEvent.click(within(detail).getByRole('button', { name: '写入文件' }))
    await settle()
      expect(spy.writeWorkspaceFile).toHaveBeenCalledTimes(1)
    const call = spy.writeWorkspaceFile.mock.calls[0] as unknown as [string, string, number, Uint8Array]
    expect(call[0]).toBe('task-1')
    expect(call[1]).toBe('evidence/page.md')
    expect(call[2]).toBe(1)
    expect(ArrayBuffer.isView(call[3])).toBe(true)
    expect(new TextDecoder().decode(call[3])).toBe('# 页面写入\n中文内容\n')
    await settle()
    expect(within(detail).getByText('evidence/page.md')).toBeInTheDocument()

    // 预览回读：内容与提交一致。
    fireEvent.click(within(within(detail).getByRole('row', { name: /notes\/summary.md/ })).getByRole('button', { name: '预览' }))
    await settle()
      expect(within(detail).getByLabelText(/文件内容（按 UTF-8 提交原始字节）/)).toHaveValue('# 巡检摘要\n\n容器列表为空，策略未变更。\n')

    // 隔离版本：选中 task-2（整理面板约定）工作区显示隔离标注。
    fireEvent.click(screen.getByRole('tab', { name: /整理面板约定/ }))
    await settle()
      expect(screen.getByText(/任务目标：整理面板约定/)).toBeInTheDocument()
    await settle()
    expect(within(detail).getByText(/来源已撤回，内容已隔离：该版本引用的 Wiki 来源已失效/)).toBeInTheDocument()
  })
})

describe('新建会话对话框', () => {
  function capabilityGateway(profiles: readonly AgentModelProfile[]) {
    const { gateway, spy } = workbenchGateway()
    // 对话框只触达这些只读方法；其余方法不会被调用，用窄对象替换即可。
    const withCapabilities: ElysianGateway = {
      ...gateway,
      agentCapabilities: {
        listModelProfiles: () => Promise.resolve(profiles),
        listExecutionProfiles: () => Promise.resolve([]),
        listGrants: () => Promise.resolve([]),
        listResourceRules: () => Promise.resolve([]),
      } as unknown as ElysianGateway['agentCapabilities'],
      agentMemory: {
        listSpaces: () => Promise.resolve([]),
      } as unknown as ElysianGateway['agentMemory'],
      agentExtensions: {
        listSkills: () => Promise.resolve([]),
        listMcpServers: () => Promise.resolve([]),
      } as unknown as ElysianGateway['agentExtensions'],
    }
    return { gateway: withCapabilities, spy }
  }

  const PROFILES: readonly AgentModelProfile[] = [
    {
      id: 'profile-1', revision: 2, name: '主力模型', baseUrl: 'https://model.example.test/v1', model: 'test-model',
      provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 65536, outputTokens: 4096, capabilities: { text: true, tools: true, source: '用户配置' },
      active: true, hasCredential: true,
    },
    {
      id: 'profile-2', revision: 1, name: '缺凭据模型', baseUrl: 'https://model.example.test/v1', model: 'test-model-2',
      provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 32768, outputTokens: 2048, capabilities: { text: true, tools: true, source: '用户配置' },
      active: true, hasCredential: false,
    },
  ]

  it('凭据缺失项禁选并提示；创建动作单飞且成功后进入会话', async () => {
    const { gateway, spy } = capabilityGateway(PROFILES)
    renderWorkbench('/agent', gateway)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /新建会话/ }))

    await settle()
    const dialog = screen.getByRole('dialog')
    await settle()
    expect(within(dialog).getByText('缺凭据模型 · test-model-2（修订 1）')).toBeInTheDocument()
    expect(within(dialog).getByText('缺少凭据，需先在能力配置补齐')).toBeInTheDocument()
    const missingRadio = within(dialog).getAllByRole('radio')[1] as HTMLInputElement
    expect(missingRadio).toBeDisabled()

    fireEvent.change(within(dialog).getByLabelText('会话标题'), { target: { value: '页面新建会话' } })
    const okRadio = within(dialog).getAllByRole('radio')[0] as HTMLInputElement
    fireEvent.click(okRadio)
    const submit = within(dialog).getByRole('button', { name: '创建会话' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    await settle()

    expect(spy.createSession).toHaveBeenCalledTimes(1)
    expect(spy.createSession).toHaveBeenCalledWith({ title: '页面新建会话', modelProfileId: 'profile-1', modelRevision: 2 })
    await settle()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await settle()
    expect(screen.getAllByText('页面新建会话').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/模型 profile-1（修订 2）/)).toBeInTheDocument()
  })

  it('空标题行内报错，不发请求', async () => {
    const { gateway, spy } = capabilityGateway(PROFILES)
    renderWorkbench('/agent', gateway)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /新建会话/ }))
    await settle()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '创建会话' }))
    await settle()
    expect(within(dialog).getByText('会话标题不能为空')).toBeInTheDocument()
    expect(spy.createSession).not.toHaveBeenCalled()
  })
})

describe('连接中断', () => {
  it('轮询失败显示「连接中断，正在重试」，输入不禁用', async () => {
    const { gateway } = workbenchGateway({ failGetSessionAfter: 2 })
    renderWorkbench('/agent?session=session-1', gateway)
    await settle()
    // 空闲节奏 15 秒：推进后轮询失败进入 degraded。
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
    await settle()
    expect(screen.getByText('连接中断，正在重试')).toBeInTheDocument()
    expect(screen.getByLabelText('新任务输入')).toBeEnabled()
  })
})


describe('深链、草稿与提交恢复', () => {
  it('深链直读未在第一页的会话、任务与 Run，并回显运行详情', async () => {
    const { gateway } = workbenchGateway()
    const session = await gateway.agentWorkbench.getSession('session-2')
    vi.spyOn(gateway.agentWorkbench, 'listSessions').mockResolvedValue({ items: [session], nextCursor: '', hasMore: false })
    vi.spyOn(gateway.agentWorkbench, 'listTasks').mockResolvedValue({ items: [], nextCursor: '', hasMore: false })
    const { router } = renderWorkbench('/agent?session=session-1&task=task-1&run=run-1', gateway)
    await settle()
    expect(useAgentWorkbenchStore.getState().selectedSessionId).toBe('session-1')
    expect(useAgentWorkbenchStore.getState().selectedTaskId).toBe('task-1')
    expect(useAgentWorkbenchStore.getState().selectedRunId).toBe('run-1')
    expect(screen.getByRole('region', { name: '任务详情面板' })).toHaveTextContent('第 1 轮')
    expect(router.state.location.search).toContain('run=run-1')
  })

  it('不接受属于另一任务的 Run 深链', async () => {
    const { gateway } = workbenchGateway()
    renderWorkbench('/agent?session=session-1&task=task-1&run=run-3', gateway)
    await settle()
    expect(useAgentWorkbenchStore.getState().selectedTaskId).toBe('task-1')
    expect(useAgentWorkbenchStore.getState().selectedRunId).toBeUndefined()
  })

  it('已挂载页面响应地址栏切换与后退，并重新核对 Run 所属任务', async () => {
    const { gateway } = workbenchGateway()
    const { router } = renderWorkbench('/agent?session=session-1&task=task-1&run=run-1', gateway)
    await settle()
    expect(useAgentWorkbenchStore.getState().selectedRunId).toBe('run-1')

    await act(async () => { await router.navigate('/agent?session=session-2&task=task-3&run=run-3') })
    await settle()
    expect(useAgentWorkbenchStore.getState().selectedSessionId).toBe('session-2')
    expect(useAgentWorkbenchStore.getState().selectedTaskId).toBe('task-3')
    expect(useAgentWorkbenchStore.getState().selectedRunId).toBe('run-3')

    await act(async () => { await router.navigate(-1) })
    await settle()
    expect(useAgentWorkbenchStore.getState().selectedSessionId).toBe('session-1')
    expect(useAgentWorkbenchStore.getState().selectedTaskId).toBe('task-1')
    expect(useAgentWorkbenchStore.getState().selectedRunId).toBe('run-1')
  })

  it('所选 Run 读取失败展示错误，可显式重试', async () => {
    const { gateway } = workbenchGateway()
    const getRun = gateway.agentRuns.getRun
    vi.spyOn(gateway.agentRuns, 'getRun').mockImplementationOnce(getRun).mockRejectedValueOnce(new Error('所选运行读取失败'))
    renderWorkbench('/agent?session=session-1&task=task-1&run=run-1', gateway)
    await settle()
    const detail = screen.getByRole('region', { name: '任务详情面板' })
    expect(within(detail).getByText('所选运行读取失败')).toBeInTheDocument()
    fireEvent.click(within(detail).getByRole('button', { name: /重试/ }))
    await settle()
    expect(detail).toHaveTextContent('第 1 轮')
  })

  it('切换任务时各自的输入草稿保留', async () => {
    const { gateway } = workbenchGateway()
    renderWorkbench('/agent?session=session-1', gateway)
    await settle()
    fireEvent.change(screen.getByLabelText('新任务输入'), { target: { value: '新任务草稿' } })
    fireEvent.click(screen.getByRole('tab', { name: /检查容器运行状态/ }))
    await settle()
    fireEvent.change(screen.getByLabelText('继续任务输入'), { target: { value: '巡检续轮草稿' } })
    fireEvent.click(screen.getByRole('tab', { name: '新建任务' }))
    await settle()
    expect(screen.getByLabelText('新任务输入')).toHaveValue('新任务草稿')
    fireEvent.click(screen.getByRole('tab', { name: /检查容器运行状态/ }))
    await settle()
    expect(screen.getByLabelText('继续任务输入')).toHaveValue('巡检续轮草稿')
  })

  it('提示参数拒绝非字符串值，正确参数随本轮输入提交', async () => {
    const { gateway, spy } = workbenchGateway()
    renderWorkbench('/agent?session=session-1', gateway)
    await settle()
    const draft = { content: '检查所选提示', skills: [], resources: [], prompts: ['mcp-demo::inspect'], promptArguments: { 'mcp-demo::inspect': '{"target":1}' } }
    act(() => useAgentWorkbenchStore.getState().setDraft('session-1:new', draft))
    fireEvent.click(screen.getByRole('button', { name: '创建并运行' }))
    await settle()
    expect(screen.getByText('提示参数必须是仅含字符串值的 JSON 对象')).toBeInTheDocument()
    expect(spy.createTask).not.toHaveBeenCalled()
    act(() => useAgentWorkbenchStore.getState().setDraft('session-1:new', { ...draft, promptArguments: { 'mcp-demo::inspect': '{"target":"容器"}' } }))
    fireEvent.click(screen.getByRole('button', { name: '创建并运行' }))
    await settle()
    expect(spy.createTask.mock.calls[0]?.[1].prompts).toEqual([{ serverId: 'mcp-demo', name: 'inspect', arguments: { target: '容器' } }])
  })

  it('响应丢失后保留原输入和 requestId，核对命中原 Run 不重发', async () => {
    const { gateway, spy } = workbenchGateway()
    let accepted: RuntimeRun | undefined
    spy.createTask.mockImplementationOnce(async (sessionId, input) => {
      accepted = workbenchInternals.createTask(sessionId, input)
      throw new Error('提交响应丢失')
    })
    const listRuns = vi.spyOn(gateway.agentRuns, 'listRuns')
    renderWorkbench('/agent?session=session-1', gateway)
    await settle()
    fireEvent.change(screen.getByLabelText('新任务输入'), { target: { value: '待核对的任务' } })
    fireEvent.click(screen.getByRole('button', { name: '创建并运行' }))
    await settle()
    const pending = useAgentWorkbenchStore.getState().pendingInputs['session-1:new']
    expect(pending?.input.content).toBe('待核对的任务')
    expect(screen.getByLabelText('新任务输入')).toHaveValue('待核对的任务')
    fireEvent.click(screen.getByRole('button', { name: '用原 ID 重试' }))
    await settle()
    expect(listRuns).toHaveBeenCalledWith({ sessionId: 'session-1', requestId: pending?.input.requestId })
    expect(spy.createTask).toHaveBeenCalledTimes(1)
    expect(useAgentWorkbenchStore.getState().selectedRunId).toBe(accepted?.id)
    expect(useAgentWorkbenchStore.getState().pendingInputs['session-1:new']).toBeUndefined()
  })

  it('打开文件后列表更新不会改变编辑器的 expectedRevision，冲突保留文本', async () => {
    const { gateway, spy } = workbenchGateway()
    renderWorkbench('/agent?session=session-1&task=task-1', gateway)
    await settle()
    const detail = screen.getByRole('region', { name: '任务详情面板' })
    fireEvent.click(within(detail).getByRole('tab', { name: '工作区' }))
    await settle()
    fireEvent.click(within(within(detail).getByRole('row', { name: /notes\/summary.md/ })).getByRole('button', { name: '预览' }))
    await settle()
    const editor = within(detail).getByLabelText(/文件内容（按 UTF-8 提交原始字节）/)
    fireEvent.change(editor, { target: { value: '保留的编辑' } })
    await gateway.agentWorkbench.writeWorkspaceFile('task-1', 'other.txt', 1, new TextEncoder().encode('changed'))
    fireEvent.click(within(detail).getByRole('button', { name: '刷新工作区' }))
    await settle()
    spy.writeWorkspaceFile.mockClear()
    fireEvent.click(within(detail).getByRole('button', { name: '保存文件' }))
    await settle()
    expect(spy.writeWorkspaceFile.mock.calls[0]?.[2]).toBe(1)
    expect(editor).toHaveValue('保留的编辑')
    expect(within(detail).getByRole('alert')).toHaveTextContent(/版本|修订|冲突/)
  })

  it('内核恢复后自动重读会话，不需要离开页面', async () => {
    const { gateway } = workbenchGateway()
    const info = await gateway.agentRuns.runtime()
    vi.spyOn(gateway.agentRuns, 'runtime').mockResolvedValueOnce({ ...info, available: false, reason: '内核暂不可用' }).mockResolvedValue(info)
    renderWorkbench('/agent', gateway)
    await settle()
    expect(screen.getByText('内核暂不可用')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    await settle()
    expect(screen.getByRole('region', { name: 'Ely 会话列表' })).toHaveTextContent('容器巡检演示')
  })
})
