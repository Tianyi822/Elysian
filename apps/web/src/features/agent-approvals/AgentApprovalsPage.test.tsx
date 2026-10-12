import { act, fireEvent, screen, within } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentApproval } from '@elysian/contracts'
import { renderApp } from '../../test/renderApp'
import { advancePoll, resetAgentTestState } from '../../test/agentTestUtils'
import { createMockGateway } from '../../adapters/mock/gateway'
import { AgentApprovalsMockAdapter } from '../../adapters/mock/agent/agentApprovalsMockAdapter'
import {
  readAgentApprovalsRunFact,
  resetAgentApprovalsData,
  setAgentApprovalsQueueFull,
} from '../../adapters/mock/agent/agentApprovalsData'
import type { AgentApprovalsAdapter, ElysianGateway } from '../../contracts/adapters'
import { useAgentApprovalsStore } from '../../stores/agentApprovalsStore'
import { useNotificationStore } from '../../stores/notificationStore'

/*
 * 审批与治理页闭环验收：详情原文逐字节展示、批准/拒绝的服务端语义回读、
 * 幂等与冲突提示、屏障与租约核实、四类能力撤销、深链过滤、六态与轮询降级。
 * 数据经唯一测试接缝注入：agentApprovals 用本域 mock 状态机（固定基准时间），
 * 撤销面板的跨域目录用假实现；不依赖其他模块的种子。
 */

const BASE = '2026-10-11T08:00:00.000Z'
const ARGS_JSON = '{"value":9007199254740993,"note":"演示审批参数，原文保留"}'

function fakeExtensionCatalogs(): Pick<ElysianGateway, 'agentExtensions' | 'agentCapabilities'> {
  const skill = { id: 'skill-demo-ops', revision: 1, createdAt: BASE, enabled: true, source: { kind: 'directory' as const, path: '/tmp/skill' }, manifest: { name: '运维演示技能', description: '演示' }, digest: 'd', bytes: 10, files: [] }
  const mcp = { id: 'mcp-11111111111111111111111111111111', revision: 2, name: '演示 MCP 服务', transport: 'streamable-http' as const, url: 'https://example/mcp', active: true, revoked: false, hasCredential: false }
  const mcpOther = { id: 'mcp-33333333333333333333333333333333', revision: 1, name: '另一个 MCP', transport: 'stdio' as const, stdio: { image: 'alpine', command: ['a'], hasEnvironment: false }, active: true, revoked: true, hasCredential: false }
  const profile = { id: 'exec-python-demo', revision: 1, enabled: true, name: 'Python 演示执行配置', image: 'python:3.12-slim', runtime: 'python' as const, command: ['python'], timeoutSeconds: 300, cpuMillis: 1000, memoryBytes: 1, pids: 128, createdAt: BASE }
  const grant = { id: 'grant-demo-workspace', revision: 1, enabled: true, name: '演示工作区授权', directories: [{ path: '/workspace', access: 'rw' as const }], network: [], privateCidrs: [], createdAt: BASE }
  return {
    agentExtensions: {
      listSkills: async () => [skill],
      getSkill: async () => skill,
      getSkillFile: async () => ({ skillId: skill.id, revision: skill.revision, path: 'SKILL.md', previewable: true, content: '' }),
      listCapabilityRevocations: async () => ({ items: [], nextCursor: '', hasMore: false }),
      setSkillEnabled: async () => skill,
      deleteSkill: async () => undefined,
      listSkillImports: async () => ({ items: [], nextCursor: '', hasMore: false }),
      createSkillImport: async () => { throw new Error('测试不触达') },
      getSkillImport: async () => { throw new Error('测试不触达') },
      cancelSkillImport: async () => { throw new Error('测试不触达') },
      deleteSkillImportRecord: async () => undefined,
      listMcpServers: async () => [mcp, mcpOther],
      createMcpServer: async () => { throw new Error('测试不触达') },
      getMcpServer: async () => mcp,
      updateMcpServer: async () => mcp,
      probeMcpServer: async () => { throw new Error('测试不触达') },
      getMcpCatalog: async () => { throw new Error('测试不触达') },
    },
    agentCapabilities: {
      discoverModels: async () => [],
      listModelServices: async () => [],
      createModelService: async () => { throw new Error("测试不触达") },
      updateModelService: async () => { throw new Error("测试不触达") },
      listModelProfiles: async () => [],
      createModelProfile: async () => { throw new Error('测试不触达') },
      updateModelProfile: async () => { throw new Error('测试不触达') },
      listExecutionProfiles: async () => [profile],
      getExecutionProfile: async () => profile,
      createExecutionProfile: async () => { throw new Error('测试不触达') },
      updateExecutionProfile: async () => { throw new Error('测试不触达') },
      setExecutionProfileEnabled: async () => profile,
      listGrants: async () => [grant],
      getGrant: async () => grant,
      createGrant: async () => { throw new Error('测试不触达') },
      updateGrant: async () => { throw new Error('测试不触达') },
      setGrantEnabled: async () => grant,
      listExecutionRuntimes: async () => [],
      listResourceRules: async () => [],
      getResourceRule: async () => { throw new Error('测试不触达') },
      createResourceRule: async () => { throw new Error('测试不触达') },
      updateResourceRule: async () => { throw new Error('测试不触达') },
    },
  }
}

function makeGateway(adapter: AgentApprovalsAdapter = new AgentApprovalsMockAdapter()): ElysianGateway {
  return {
    ...createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 }),
    agentApprovals: adapter,
    ...fakeExtensionCatalogs(),
  }
}

/**
 * 在真实 mock 适配器实例上覆盖个别方法（Object.assign 落成自有属性，运行时生效）。
 * 覆盖方法内部如需回落到原实现，必须另建实例调用——回落到被覆盖的同一实例会自递归。
 */
function withOverrides(base: AgentApprovalsAdapter, overrides: Partial<AgentApprovalsAdapter>): AgentApprovalsAdapter {
  return Object.assign(base, overrides)
}

function rowOf(text: string): HTMLElement {
  const cell = screen.getByText(text)
  return cell.closest('tr') as HTMLElement
}

async function openPendingWriteDetail() {
  await screen.findByText('mcp_demo_status_write')
  await act(async () => {
    within(rowOf('mcp_demo_status_write')).getByRole('button', { name: '查看详情' }).click()
  })
  await screen.findByText(/审批详情 · ap-pending-write/)
}

beforeEach(() => {
  resetAgentTestState()
  resetAgentApprovalsData(BASE)
  useAgentApprovalsStore.getState().reset()
  useNotificationStore.getState().clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('待审批页签', () => {
  it('列表呈现服务端序与全生命周期状态；工作流节点深链到 /agent/workflows', async () => {
    renderApp('/agent/approvals', { gateway: makeGateway() })
    expect(await screen.findByText('mcp_demo_status_write')).toBeInTheDocument()
    expect(screen.getByText('已执行审批')).toBeInTheDocument()
    expect(screen.getByText('已拒绝')).toBeInTheDocument()
    expect(screen.getAllByText('已过期').length).toBeGreaterThan(0)
    const nodeLink = screen.getByRole('link', { name: 'node-write' })
    expect(nodeLink).toHaveAttribute('href', '/agent/workflows?instanceId=wf-demo-1&nodeId=node-write')
    expect(screen.getByRole('link', { name: 'run-pending' })).toHaveAttribute('href', '/agent/runs?runId=run-pending')
  })

  it('详情以 argumentsJson 原文逐字节展示（未经重序列化），并带复制按钮', async () => {
    renderApp('/agent/approvals', { gateway: makeGateway() })
    await openPendingWriteDetail()
    const pre = screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === ARGS_JSON)
    expect(pre).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '调用参数原文' })).toBeInTheDocument()
    expect(screen.getByText('需要审批')).toBeInTheDocument()
    expect(screen.getByText('demo-snapshot-digest')).toBeInTheDocument()
    expect(screen.getByText('第 3 版')).toBeInTheDocument()
    expect(screen.getByText('Python 演示执行配置')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批准并继续' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拒绝并终止' })).toBeInTheDocument()
  })

  it('批准闭环：状态推进 approved、Run 回 queued；「已同意」不冒充「已执行审批」', async () => {
    renderApp('/agent/approvals', { gateway: makeGateway() })
    await openPendingWriteDetail()
    await act(async () => {
      screen.getByRole('button', { name: '批准并继续' }).click()
    })
    expect(await screen.findByText('已同意')).toBeInTheDocument()
    expect(readAgentApprovalsRunFact('run-pending')?.status).toBe('queued')
    expect(screen.getByText('已批准并继续：关联运行将重新排队执行')).toBeInTheDocument()
  })

  it('服务端继续推进到 consumed 时页面如实呈现（批准不等于已执行成功）', async () => {
    let decided = false
    const pending = (): AgentApproval => ({
      id: 'ap-scripted', runId: 'run-scripted', operationId: 'op-scripted', status: 'pending',
      createdAt: BASE, expiresAt: '2999-01-01T00:00:00Z',
      operation: {
        id: 'op-scripted', runId: 'run-scripted', taskId: 'task-scripted', modelRequestId: 'm', callIndex: 0, modelCallId: 'c',
        argumentsJson: '{"a":1}', capability: { name: 'scripted_tool', description: 'd', parameters: {}, source: 'builtin', ref: { id: 'builtin', revision: 1 }, readOnly: false },
        snapshotDigest: 'sd', workspaceRevision: 1, policy: '', status: 'waiting-approval', callId: 'call', createdAt: BASE,
      },
    })
    const adapter = withOverrides(new AgentApprovalsMockAdapter(), {
      listApprovals: async () => [decided ? { ...pending(), status: 'consumed', decision: 'approved', decidedAt: BASE } : pending()],
      decideApproval: async () => {
        decided = true
        return { ...pending(), status: 'approved', decision: 'approved', decidedAt: BASE }
      },
    })
    renderApp('/agent/approvals', { gateway: makeGateway(adapter) })
    await screen.findByText('scripted_tool')
    await act(async () => {
      within(rowOf('scripted_tool')).getByRole('button', { name: '查看详情' }).click()
    })
    await act(async () => {
      screen.getByRole('button', { name: '批准并继续' }).click()
    })
    expect(await screen.findByText('已执行审批')).toBeInTheDocument()
  })

  it('拒绝闭环：工作流闸门拒绝后 Run 终态 failed(approval-denied) 且记忆标 stale', async () => {
    renderApp('/agent/approvals', { gateway: makeGateway() })
    await screen.findByText('工作流闸门 · confirm')
    await act(async () => {
      within(rowOf('工作流闸门 · confirm')).getByRole('button', { name: '查看详情' }).click()
    })
    await screen.findByText(/审批详情 · ap-gate-confirm/)
    await act(async () => {
      screen.getByRole('button', { name: '拒绝并终止' }).click()
    })
    expect(await within(rowOf('工作流闸门 · confirm')).findByText('已拒绝')).toBeInTheDocument()
    const run = readAgentApprovalsRunFact('run-gate')
    expect(run?.status).toBe('failed')
    expect(run?.endReason).toBe('approval-denied')
    expect(run?.memoryStatus).toBe('stale')
  })

  it('不同决定冲突：服务端 409 decision-conflict 的中文提示透传，审批保持待审批', async () => {
    const adapter = withOverrides(new AgentApprovalsMockAdapter(), {
      decideApproval: async () => {
        throw Object.assign(new Error('审批已处理、过期或撤销'), { code: 'decision-conflict' })
      },
    })
    renderApp('/agent/approvals', { gateway: makeGateway(adapter) })
    await openPendingWriteDetail()
    await act(async () => {
      screen.getByRole('button', { name: '批准并继续' }).click()
    })
    expect(await screen.findByText('审批已处理、过期或撤销')).toBeInTheDocument()
    expect(within(rowOf('run-pending')).getByText('待审批')).toBeInTheDocument()
  })

  it('批准遇 429 queue-full：提示队列已满且状态仍待审批', async () => {
    setAgentApprovalsQueueFull(true)
    try {
      renderApp('/agent/approvals', { gateway: makeGateway() })
      await openPendingWriteDetail()
      await act(async () => {
        screen.getByRole('button', { name: '批准并继续' }).click()
      })
      expect(await screen.findByText('任务队列已满，审批保持待处理')).toBeInTheDocument()
      expect(within(rowOf('run-pending')).getByText('待审批')).toBeInTheDocument()
    } finally {
      setAgentApprovalsQueueFull(false)
    }
  })

  it('runId 深链过滤全量数组，清除后回到全量', async () => {
    renderApp('/agent/approvals?runId=run-pending', { gateway: makeGateway() })
    expect(await screen.findByText('mcp_demo_status_write')).toBeInTheDocument()
    expect(screen.queryByText('工作流闸门 · confirm')).not.toBeInTheDocument()
    expect(screen.getByText('Run 过滤：run-pending')).toBeInTheDocument()
    await act(async () => {
      screen.getByRole('button', { name: '清除 Run 过滤' }).click()
    })
    expect(await screen.findByText('工作流闸门 · confirm')).toBeInTheDocument()
  })

  it('读取失败给错误态与重试；重试成功恢复列表', async () => {
    let fail = true
    const adapter = withOverrides(new AgentApprovalsMockAdapter(), {
      listApprovals: async (workflowId?: string) => {
        if (fail) throw new Error('Agent 请求网络失败')
        return new AgentApprovalsMockAdapter().listApprovals(workflowId)
      },
    })
    renderApp('/agent/approvals', { gateway: makeGateway(adapter) })
    expect(await screen.findByText('审批列表读取失败')).toBeInTheDocument()
    fail = false
    await act(async () => {
      screen.getByRole('button', { name: '重试' }).click()
    })
    expect(await screen.findByText('mcp_demo_status_write')).toBeInTheDocument()
  })
})

describe('执行屏障页签', () => {
  it('常驻说明卡与 dispatched/unknown 区分：unknown 可核实、dispatched 禁用并说明', async () => {
    renderApp('/agent/approvals?tab=barriers', { gateway: makeGateway() })
    expect(await screen.findByText(/结果未知不代表失败/)).toBeInTheDocument()
    expect(await screen.findByText('op-unknown-script')).toBeInTheDocument()
    const dispatchedRow = rowOf('op-dispatched-script')
    const dispatchedButton = within(dispatchedRow).getByRole('button', { name: '人工核实' })
    expect(dispatchedButton).toBeDisabled()
    expect(dispatchedButton).toHaveAttribute('title', '在途操作必须先结束确认流程，暂不能人工核实')
    expect(within(rowOf('op-unknown-script')).getByRole('button', { name: '人工核实' })).toBeEnabled()
  })

  it('核实闭环：空证据被拦；confirmed-stopped 后屏障关闭并提示租约已释放', async () => {
    renderApp('/agent/approvals?tab=barriers', { gateway: makeGateway() })
    await screen.findByText('op-unknown-script')
    await act(async () => {
      within(rowOf('op-unknown-script')).getByRole('button', { name: '人工核实' }).click()
    })
    await screen.findByText(/人工核实执行屏障/)
    await act(async () => {
      screen.getByRole('button', { name: '提交核实结论' }).click()
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('核实证据必须为 1 到 8192 字节')
    fireEvent.change(screen.getByLabelText(/外部核实证据/), { target: { value: '容器已退出，日志完整。' } })
    await act(async () => {
      screen.getByRole('button', { name: '提交核实结论' }).click()
    })
    expect(await screen.findByText('屏障已核实并关闭；关联资源租约已释放')).toBeInTheDocument()
    expect(within(rowOf('op-unknown-script')).getByText('已核实关闭')).toBeInTheDocument()
  })
})

describe('资源租约页签', () => {
  it('mcp-probe 租约仅 confirmed-stopped 可选；核实后释放；操作租约不给入口', async () => {
    renderApp('/agent/approvals?tab=locks', { gateway: makeGateway() })
    await screen.findByText('probe-demo-1')
    await act(async () => {
      within(rowOf('probe-demo-1')).getByRole('button', { name: '核实已停止' }).click()
    })
    const enabledRadio = screen.getByRole('radio', { name: /确认已停止（confirmed-stopped）/ })
    const disabledRadio = screen.getAllByRole('radio').find((radio) => radio !== enabledRadio) as HTMLInputElement
    expect(enabledRadio).toBeChecked()
    expect(disabledRadio).toBeDisabled()
    const textarea = screen.getByLabelText(/外部停止证据/) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'docker ps -a 无该容器。' } })
    await act(async () => {
      screen.getByRole('button', { name: '确认已停止并释放租约' }).click()
    })
    expect(await screen.findByText('租约已核实并释放，MCP 探测可继续')).toBeInTheDocument()
    // 探测租约核实后从「停止未确认」变为「已释放」；操作租约始终经屏障核实。
    expect(within(rowOf('probe-demo-1')).getAllByText('已释放').length).toBeGreaterThan(0)
    expect(within(rowOf('scope-agent')).getByText('经屏障核实')).toBeInTheDocument()
  })
})

describe('能力撤销面板', () => {
  it('技能/执行配置/授权各撤销一次：无 requestId、回读已撤销、引用标注、空 reason 前端拦截', async () => {
    const calls: Array<{ kind: string; id: string; revision: number; reason: string }> = []
    const adapter = withOverrides(new AgentApprovalsMockAdapter(), {
      revokeSkill: async (id, revision, reason) => {
        calls.push({ kind: 'skill', id, revision, reason })
        return new AgentApprovalsMockAdapter().revokeSkill(id, revision, reason)
      },
      revokeExecutionProfile: async (id, revision, reason) => {
        calls.push({ kind: 'execution-profile', id, revision, reason })
        return new AgentApprovalsMockAdapter().revokeExecutionProfile(id, revision, reason)
      },
      revokeGrant: async (id, revision, reason) => {
        calls.push({ kind: 'grant', id, revision, reason })
        return new AgentApprovalsMockAdapter().revokeGrant(id, revision, reason)
      },
    })
    renderApp('/agent/approvals', { gateway: makeGateway(adapter) })
    await screen.findByText('运维演示技能')
    // 被审批引用的能力（演示 MCP 服务，capability.ref 命中）标注引用中。
    expect(within(rowOf('演示 MCP 服务')).getByText('审批引用中')).toBeInTheDocument()
    const expectNotification: Record<string, RegExp> = {
      '运维演示技能': /已撤销技能「运维演示技能」/,
      'Python 演示执行配置': /已撤销执行配置「Python 演示执行配置」/,
      '演示工作区授权': /已撤销授权「演示工作区授权」/,
    }
    for (const name of Object.keys(expectNotification)) {
      await act(async () => {
        within(rowOf(name)).getByRole('button', { name: '撤销…' }).click()
      })
      await screen.findByText(/撤销原因/)
      await act(async () => {
        screen.getByRole('button', { name: '确认撤销' }).click()
      })
      expect(await screen.findByRole('alert')).toHaveTextContent('撤销原因必须为 1 到 2048 字节')
      fireEvent.change(screen.getByLabelText(/撤销原因/), { target: { value: '内容过期，撤销后不再可用。' } })
      await act(async () => {
        screen.getByRole('button', { name: '确认撤销' }).click()
      })
      expect(await screen.findByText(expectNotification[name] as RegExp)).toBeInTheDocument()
    }
    expect(calls.map((call) => call.kind).sort()).toEqual(['execution-profile', 'grant', 'skill'])
    expect(calls.every((call) => call.revision === 1 && call.reason === '内容过期，撤销后不再可用。')).toBe(true)
    // 撤销后行标注「已撤销」且按钮变为已撤销（标注徽标与按钮文案同词，按行内多处命中断言）。
    expect(within(rowOf('运维演示技能')).getAllByText('已撤销').length).toBeGreaterThan(0)
  })
})

describe('静默轮询', () => {
  it('页签挂载后 10 秒静默刷新；连续失败给出降级提示', async () => {
    vi.useFakeTimers()
    let calls = 0
    let fail = false
    const adapter = withOverrides(new AgentApprovalsMockAdapter(), {
      listApprovals: async (workflowId?: string) => {
        calls += 1
        if (fail) throw new Error('Agent 请求网络失败')
        return new AgentApprovalsMockAdapter().listApprovals(workflowId)
      },
    })
    renderApp('/agent/approvals', { gateway: makeGateway(adapter) })
    // fake timers 下不用 findBy*（waitFor 的轮询间隔也被冻结）：首轮加载在 act 内冲完。
    await act(async () => { await advancePoll(0) })
    expect(screen.getByText('mcp_demo_status_write')).toBeInTheDocument()
    const initial = calls
    fail = true
    await act(async () => { await advancePoll(10_000) })
    await act(async () => { await advancePoll(20_000) })
    expect(screen.getByText('连接中断，正在重试')).toBeInTheDocument()
    expect(calls).toBeGreaterThan(initial)
  })
})
