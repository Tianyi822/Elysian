import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentCreateWorkflowInput,
  AgentWorkflowAttempt,
  AgentWorkflowEvent,
  AgentWorkflowInstance,
} from '@elysian/contracts'
import type { AgentWorkflowsAdapter, ElysianGateway } from '../contracts/adapters'
import {
  WORKFLOW_CONTRACT_CREATE_INPUT,
  WORKFLOW_INSTANCE_BACKUP_SUCCEEDED,
  WORKFLOW_INSTANCE_PORTAL_RECOVERY,
  WORKFLOW_INSTANCE_PORTAL_RUNNING,
} from '../adapters/agentWorkflowsFixtures'
import { AgentWorkflowsMockAdapter, resetAgentWorkflowsData } from '../adapters/mock/agent/agentWorkflowsMockAdapter'
import { setAgentWorkflowBarrierCount } from '../adapters/mock/agent/agentWorkflowsData'
import { useAgentWorkflowsStore } from './agentWorkflowsStore'

/*
 * 工作流 store 行为：分页、切换实例作废在途读取、事件按 seq 去重合并（乱序安全）、
 * 静默刷新失败保留旧内容、取消与恢复回写详情与列表。
 */

function gatewayWith(adapter: Partial<AgentWorkflowsAdapter>): ElysianGateway {
  const base = new AgentWorkflowsMockAdapter()
  return { agentWorkflows: Object.assign(base, adapter) } as unknown as ElysianGateway
}

function events(seqs: readonly string[]): readonly AgentWorkflowEvent[] {
  return seqs.map((seq) => ({ workflowId: 'wf-inst-portal-01', seq, type: 'workflow/tick', at: '2026-10-11T01:00:00.000Z' }))
}

describe('agentWorkflowsStore', () => {
  beforeEach(() => {
    resetAgentWorkflowsData()
    useAgentWorkflowsStore.getState().reset()
  })

  it('loadInstances 装载首页，loadMoreInstances 追加且游标保持字符串', async () => {
    const gateway = gatewayWith({
      listInstances: async (query) => {
        const cursor = query.cursor ?? ''
        if (cursor === '') return { items: [WORKFLOW_INSTANCE_PORTAL_RUNNING], nextCursor: '2', hasMore: true }
        return { items: [WORKFLOW_INSTANCE_BACKUP_SUCCEEDED], nextCursor: '', hasMore: false }
      },
    })
    const store = useAgentWorkflowsStore.getState()
    await store.loadInstances(gateway)
    expect(useAgentWorkflowsStore.getState().instances.items).toHaveLength(1)
    expect(useAgentWorkflowsStore.getState().instances.hasMore).toBe(true)
    await useAgentWorkflowsStore.getState().loadMoreInstances(gateway)
    const merged = useAgentWorkflowsStore.getState().instances.items
    expect(merged.map((item) => item.id)).toEqual(['wf-inst-portal-01', 'wf-inst-backup-01'])
    expect(useAgentWorkflowsStore.getState().instances.hasMore).toBe(false)
  })

  it('selectInstance 装载详情、尝试与事件首页；切换实例作废慢响应', async () => {
    let resolveSlow: (value: AgentWorkflowInstance) => void = () => {}
    const slowInstance = new Promise<AgentWorkflowInstance>((resolve) => {
      resolveSlow = resolve
    })
    const gateway = gatewayWith({
      getInstance: vi.fn(async (instanceId: string) => {
        if (instanceId === 'wf-inst-slow') return slowInstance
        return { ...WORKFLOW_INSTANCE_PORTAL_RECOVERY }
      }),
      listAttempts: vi.fn(async () => ({ items: [{ workflowId: 'x', stepId: 's', number: 1, runId: 'r', runNumber: 1, status: 'succeeded', inputJson: '{}', workspaceRevision: 1, createdAt: '2026-10-11T01:00:00.000Z' } satisfies AgentWorkflowAttempt], nextCursor: '', hasMore: false })),
      listInstanceEvents: vi.fn(async () => ({ items: events(['1', '2']), nextCursor: '', hasMore: false })),
    })
    const pendingSlow = useAgentWorkflowsStore.getState().selectInstance(gateway, 'wf-inst-slow')
    expect(useAgentWorkflowsStore.getState().detail.status).toBe('loading')
    await useAgentWorkflowsStore.getState().selectInstance(gateway, 'wf-inst-portal-02')
    await vi.waitFor(() => {
      expect(useAgentWorkflowsStore.getState().detail.status).toBe('ready')
    })
    // 慢响应后到：sequence 已作废，不覆盖新实例的详情。
    resolveSlow({ ...WORKFLOW_INSTANCE_PORTAL_RUNNING })
    await pendingSlow
    await vi.waitFor(() => {
      expect(useAgentWorkflowsStore.getState().detail.instance?.id).toBe('wf-inst-portal-02')
    })
    expect(useAgentWorkflowsStore.getState().attempts.items).toHaveLength(1)
    expect(useAgentWorkflowsStore.getState().events.items.map((item) => item.seq)).toEqual(['1', '2'])
  })

  it('事件增量轮询按 seq 去重合并，乱序与重复到达都不重复', async () => {
    let call = 0
    const gateway = gatewayWith({
      getInstance: async () => ({ ...WORKFLOW_INSTANCE_PORTAL_RUNNING }),
      getExecutionTree: async () => ({ rootScopeId: '', scopes: [], nodes: [] }),
      listInstanceEvents: async () => {
        call += 1
        if (call === 1) return { items: events(['1', '2', '3']), nextCursor: '', hasMore: false }
        // 第二轮乱序回放 + 新事件。
        return { items: events(['3', '2', '9', '10']), nextCursor: '', hasMore: false }
      },
    })
    await useAgentWorkflowsStore.getState().selectInstance(gateway, 'wf-inst-portal-01')
    await vi.waitFor(() => expect(useAgentWorkflowsStore.getState().events.status).toBe('ready'))
    await useAgentWorkflowsStore.getState().pollEvents(gateway)
    const seqs = useAgentWorkflowsStore.getState().events.items.map((item) => item.seq)
    expect(seqs).toEqual(['1', '2', '3', '9', '10'])
  })

  it('尝试和事件轮询续读后续页，末页重扫更新状态且不重复记录', async () => {
    const cursor = '900719925474099312345'
    const attempt: AgentWorkflowAttempt = {
      workflowId: 'wf-inst-portal-01', stepId: 's1', number: 1, runId: 'run-1', runNumber: 1,
      status: 'running', inputJson: '{}', workspaceRevision: 1, createdAt: '2026-10-11T01:00:00.000Z',
    }
    let rescanning = false
    const listAttempts = vi.fn<AgentWorkflowsAdapter['listAttempts']>(async (_instanceId, query) =>
      query?.cursor === cursor
        ? { items: [{ ...attempt, stepId: 's2', runId: 'run-2', status: 'succeeded' }], nextCursor: '', hasMore: false }
        : { items: [{ ...attempt, status: rescanning ? 'succeeded' : 'running' }], nextCursor: cursor, hasMore: true })
    const listInstanceEvents = vi.fn<AgentWorkflowsAdapter['listInstanceEvents']>(async (_instanceId, query) =>
      query?.cursor === cursor
        ? { items: events(['2']), nextCursor: '', hasMore: false }
        : { items: events(['1']), nextCursor: cursor, hasMore: true })
    const gateway = gatewayWith({
      getInstance: async () => ({ ...WORKFLOW_INSTANCE_PORTAL_RUNNING }),
      getExecutionTree: async () => ({ rootScopeId: '', scopes: [], nodes: [] }),
      listAttempts,
      listInstanceEvents,
    })
    await useAgentWorkflowsStore.getState().selectInstance(gateway, 'wf-inst-portal-01')
    await vi.waitFor(() => expect(useAgentWorkflowsStore.getState().attempts.status).toBe('ready'))
    await useAgentWorkflowsStore.getState().refreshInstance(gateway)
    expect(listAttempts).toHaveBeenLastCalledWith('wf-inst-portal-01', { cursor }, undefined)
    expect(listInstanceEvents).toHaveBeenLastCalledWith('wf-inst-portal-01', { cursor }, undefined)
    expect(useAgentWorkflowsStore.getState().attempts.hasMore).toBe(false)
    expect(useAgentWorkflowsStore.getState().events.hasMore).toBe(false)

    rescanning = true
    await useAgentWorkflowsStore.getState().refreshInstance(gateway)
    await useAgentWorkflowsStore.getState().loadMoreAttempts(gateway)
    const state = useAgentWorkflowsStore.getState()
    expect(state.attempts.items.map((item) => [item.runId, item.status])).toEqual([
      ['run-1', 'succeeded'], ['run-2', 'succeeded'],
    ])
    expect(state.events.items.map((item) => item.seq)).toEqual(['1', '2'])
  })

  it('静默刷新失败保留旧内容（不置 error、不清详情）；非静默刷新显示错误', async () => {
    let fail = false
    const gateway = gatewayWith({
      getInstance: async () => {
        if (fail) throw new Error('网络中断')
        return { ...WORKFLOW_INSTANCE_PORTAL_RUNNING }
      },
      getExecutionTree: async () => ({ rootScopeId: '', scopes: [], nodes: [] }),
      listInstanceEvents: async () => ({ items: [], nextCursor: '', hasMore: false }),
    })
    await useAgentWorkflowsStore.getState().selectInstance(gateway, 'wf-inst-portal-01')
    await vi.waitFor(() => expect(useAgentWorkflowsStore.getState().detail.status).toBe('ready'))
    fail = true
    await expect(useAgentWorkflowsStore.getState().refreshInstance(gateway, { silent: true })).rejects.toThrow('网络中断')
    expect(useAgentWorkflowsStore.getState().detail.status).toBe('ready')
    expect(useAgentWorkflowsStore.getState().detail.instance?.id).toBe('wf-inst-portal-01')
    expect(useAgentWorkflowsStore.getState().detail.errorMessage).toBeUndefined()
  })

  it('轮询信号传入详情、尝试与事件；取消后的响应不回填', async () => {
    const controller = new AbortController()
    const getInstance = vi.fn<AgentWorkflowsAdapter['getInstance']>(async () => ({ ...WORKFLOW_INSTANCE_PORTAL_RUNNING }))
    const listAttempts = vi.fn<AgentWorkflowsAdapter['listAttempts']>(async () => ({ items: [], nextCursor: '', hasMore: false }))
    const listInstanceEvents = vi.fn<AgentWorkflowsAdapter['listInstanceEvents']>(async () => ({ items: [], nextCursor: '', hasMore: false }))
    const gateway = gatewayWith({ getInstance, listAttempts, listInstanceEvents })
    await useAgentWorkflowsStore.getState().selectInstance(gateway, 'wf-inst-portal-01')
    await useAgentWorkflowsStore.getState().refreshInstance(gateway, { silent: true, signal: controller.signal })
    expect(getInstance).toHaveBeenLastCalledWith('wf-inst-portal-01', controller.signal)
    expect(listAttempts).toHaveBeenLastCalledWith('wf-inst-portal-01', {}, controller.signal)
    expect(listInstanceEvents).toHaveBeenLastCalledWith('wf-inst-portal-01', {}, controller.signal)
    getInstance.mockImplementationOnce(async () => {
      controller.abort()
      return { ...WORKFLOW_INSTANCE_PORTAL_RUNNING, revision: 999 }
    })
    await useAgentWorkflowsStore.getState().refreshInstance(gateway, { silent: true, signal: controller.signal })
    expect(useAgentWorkflowsStore.getState().detail.instance?.revision).not.toBe(999)
  })

  it('cancelInstance 与 recoverInstance 把结果回写详情并刷新列表', async () => {
    const gateway = gatewayWith({})
    await useAgentWorkflowsStore.getState().selectInstance(gateway, 'wf-inst-portal-01')
    await vi.waitFor(() => expect(useAgentWorkflowsStore.getState().detail.status).toBe('ready'))
    const cancelled = await useAgentWorkflowsStore.getState().cancelInstance(gateway, 'wf-inst-portal-01')
    expect(cancelled.cancelRequestedAt).toBeDefined()
    expect(useAgentWorkflowsStore.getState().detail.instance?.cancelRequestedAt).toBeDefined()
    // 取消后的下一次读取推进为已取消终态（「已请求取消」≠「已取消」的两段呈现）。
    await useAgentWorkflowsStore.getState().refreshInstance(gateway)
    expect(useAgentWorkflowsStore.getState().detail.instance?.status).toBe('cancelled')

    await useAgentWorkflowsStore.getState().selectInstance(gateway, 'wf-inst-portal-02')
    await vi.waitFor(() => expect(useAgentWorkflowsStore.getState().detail.status).toBe('ready'))
    const recovered = await useAgentWorkflowsStore.getState().recoverInstance(gateway, 'wf-inst-portal-02', {
      requestId: 'store-recover-1',
      expectedRevision: useAgentWorkflowsStore.getState().detail.instance?.revision ?? 5,
      action: 'retry',
      evidence: 'store 测试核实说明',
      nodeId: 'node-analyze-logs-02',
    })
    expect(recovered.status).toBe('ready')
    expect(useAgentWorkflowsStore.getState().detail.instance?.status).toBe('running')
  })

  it('createInstance 透传结果并刷新列表；requestId 幂等由 adapter 承担', async () => {
    const gateway = gatewayWith({})
    const input: AgentCreateWorkflowInput = { ...WORKFLOW_CONTRACT_CREATE_INPUT }
    const first = await useAgentWorkflowsStore.getState().createInstance(gateway, input)
    const replay = await useAgentWorkflowsStore.getState().createInstance(gateway, input)
    expect(replay.id).toBe(first.id)
    const list = useAgentWorkflowsStore.getState().instances.items
    expect(list.some((item) => item.id === first.id)).toBe(true)
  })

  it('屏障阻断恢复时错误冒泡给调用方（页面据此展示治理中心深链）', async () => {
    setAgentWorkflowBarrierCount(1)
    const gateway = gatewayWith({})
    await expect(
      useAgentWorkflowsStore.getState().recoverInstance(gateway, 'wf-inst-portal-02', {
        requestId: 'blocked-recover',
        expectedRevision: 5,
        action: 'retry',
        evidence: '被屏障阻断的恢复',
        nodeId: 'node-analyze-logs-02',
      }),
    ).rejects.toThrow('必须先核实全部未知执行屏障')
  })
})
