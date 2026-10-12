import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentApproval, AgentExecutionBarrier, AgentOperation, AgentResourceLease } from '@elysian/contracts'
import type { AgentApprovalsAdapter, ElysianGateway } from '../contracts/adapters'
import {
  collectApprovalReferencedIds,
  isQueueFullError,
  selectApprovalsByRun,
  useAgentApprovalsStore,
} from './agentApprovalsStore'
import { resetAgentApprovalsData } from '../adapters/mock/agent/agentApprovalsData'

/*
 * 审批与治理 store：六态推进、单飞锁（同目标并发只发一次）、动作后静默回读、
 * 屏障核实联动释放租约的对比判定与撤销事实入册。全部用假 adapter 注入，
 * 不依赖 mock 数据集的实现细节。
 */

const PENDING: AgentApproval = {
  id: 'ap-1', runId: 'run-1', operationId: 'op-1', status: 'pending',
  createdAt: '2026-10-11T07:00:00Z', expiresAt: '2026-10-12T07:00:00Z',
  operation: {
    id: 'op-1', runId: 'run-1', taskId: 'task-1', modelRequestId: 'm1', callIndex: 0, modelCallId: 'c1',
    argumentsJson: '{"value":9007199254740993}',
    capability: { name: 'tool', description: 'd', parameters: {}, source: 'mcp-tool', ref: { id: 'mcp-1', revision: 1 }, readOnly: false },
    snapshotDigest: 'sd', workspaceRevision: 2, policy: 'approval-required', status: 'waiting-approval', callId: 'call-1',
    createdAt: '2026-10-11T07:00:00Z',
    execution: {
      profile: { id: 'exec-1', revision: 1, enabled: true, name: 'p', image: 'i', runtime: 'python', command: ['python'], timeoutSeconds: 30, cpuMillis: 1, memoryBytes: 1, pids: 1, createdAt: '2026-10-11T07:00:00Z' },
      grant: { id: 'grant-1', revision: 1, enabled: true, name: 'g', directories: [], network: [], privateCidrs: [], createdAt: '2026-10-11T07:00:00Z' },
      scriptDigest: 'gd',
    },
  },
}

const BARRIER: AgentExecutionBarrier = {
  id: 'bar-1', runId: 'run-1', operationId: 'op-1', status: 'unknown', createdAt: '2026-10-11T07:00:00Z',
}

function makeFakeAdapter(overrides: Partial<AgentApprovalsAdapter> = {}): AgentApprovalsAdapter & {
  calls: { listApprovals: number; decide: ReadonlyArray<{ id: string; decision: string }>; reconcileBarrier: number; reconcileLock: number; revoke: number }
} {
  const calls: {
    listApprovals: number
    decide: Array<{ id: string; decision: string }>
    reconcileBarrier: number
    reconcileLock: number
    revoke: number
  } = { listApprovals: 0, decide: [], reconcileBarrier: 0, reconcileLock: 0, revoke: 0 }
  const adapter: AgentApprovalsAdapter & { calls: typeof calls } = {
    calls,
    async listApprovals() {
      calls.listApprovals += 1
      return [PENDING]
    },
    async decideApproval(id, input) {
      calls.decide.push({ id, decision: input.decision })
      return { ...PENDING, status: input.decision, decision: input.decision, decidedAt: '2026-10-11T08:00:00Z' }
    },
    async listOperations() { return [PENDING.operation] as readonly AgentOperation[] },
    async listContextItems() { return [] },
    async listBarriers() { return [BARRIER] },
    async reconcileBarrier(_id, input) {
      calls.reconcileBarrier += 1
      return { ...BARRIER, status: 'reconciled', decision: input.decision, evidence: input.evidence, reconciledAt: '2026-10-11T08:00:00Z' }
    },
    async listResourceLocks(): Promise<readonly AgentResourceLease[]> {
      return [{ id: 'lock-1', runId: 'run-1', operationId: 'op-1', scopeId: 'scope-1', state: 'unknown', claims: [], createdAt: '2026-10-11T07:00:00Z' }]
    },
    async reconcileResourceLock(_id) {
      calls.reconcileLock += 1
      return { id: 'lock-1', scopeId: 'scope-probe', state: 'released', claims: [], createdAt: '2026-10-11T07:00:00Z', evidence: 'e', decision: 'confirmed-stopped' as const }
    },
    async revokeSkill() { calls.revoke += 1; return { revoked: true } },
    async revokeMcpServer() { return { revoked: true } },
    async revokeExecutionProfile() { return { revoked: true } },
    async revokeGrant() { return { revoked: true } },
    ...overrides,
  }
  return adapter
}

function makeGateway(adapter: AgentApprovalsAdapter): ElysianGateway {
  return { agentApprovals: adapter } as unknown as ElysianGateway
}

beforeEach(() => {
  useAgentApprovalsStore.getState().reset()
  resetAgentApprovalsData('2026-10-11T08:00:00.000Z')
})

describe('列表加载', () => {
  it('首轮 loading→ready；静默重读保留旧内容', async () => {
    const adapter = makeFakeAdapter()
    const gateway = makeGateway(adapter)
    const store = useAgentApprovalsStore.getState()
    expect(useAgentApprovalsStore.getState().approvalsStatus).toBe('idle')
    const pending = store.loadApprovals(gateway)
    expect(useAgentApprovalsStore.getState().approvalsStatus).toBe('loading')
    await pending
    expect(useAgentApprovalsStore.getState().approvalsStatus).toBe('ready')
    expect(useAgentApprovalsStore.getState().approvals).toHaveLength(1)
    await useAgentApprovalsStore.getState().loadApprovals(gateway, { silent: true })
    expect(useAgentApprovalsStore.getState().approvalsStatus).toBe('ready')
  })

  it('失败落到 error 状态并保留中文错误；重试成功恢复', async () => {
    let fail = true
    const adapter = makeFakeAdapter({
      listApprovals: async () => {
        if (fail) throw new Error('任务队列已满，审批保持待处理')
        return [PENDING]
      },
    })
    const gateway = makeGateway(adapter)
    await useAgentApprovalsStore.getState().loadApprovals(gateway)
    expect(useAgentApprovalsStore.getState().approvalsStatus).toBe('error')
    expect(useAgentApprovalsStore.getState().approvalsError).toBe('任务队列已满，审批保持待处理')
    fail = false
    await useAgentApprovalsStore.getState().loadApprovals(gateway)
    expect(useAgentApprovalsStore.getState().approvalsStatus).toBe('ready')
  })
})

describe('决定审批：单飞与回读', () => {
  it('同审批并发决定只发一次；成功后静默回读审批列表', async () => {
    let release: (() => void) | undefined
    const seen: Array<{ id: string; decision: string }> = []
    const adapter = makeFakeAdapter({
      decideApproval: async (id, input) => {
        seen.push({ id, decision: input.decision })
        await new Promise<void>((resolve) => { release = resolve })
        return { ...PENDING, status: input.decision, decision: input.decision }
      },
    })
    const gateway = makeGateway(adapter)
    const first = useAgentApprovalsStore.getState().decideApproval(gateway, 'ap-1', 'approved')
    const second = await useAgentApprovalsStore.getState().decideApproval(gateway, 'ap-1', 'approved')
    expect(second).toBeUndefined()
    release?.()
    const decided = await first
    expect(decided?.status).toBe('approved')
    expect(seen).toHaveLength(1)
    // 本用例没有首轮加载：这一次 listApprovals 就是决定成功后的静默回读。
    expect(adapter.calls.listApprovals).toBe(1)
  })

  it('queue-full 错误码可判定', () => {
    expect(isQueueFullError(Object.assign(new Error('任务队列已满，审批保持待处理'), { code: 'queue-full' }))).toBe(true)
    expect(isQueueFullError(Object.assign(new Error('冲突'), { code: 'decision-conflict' }))).toBe(false)
    expect(isQueueFullError(new Error('无码'))).toBe(false)
  })
})

describe('屏障核实：联动释放租约判定', () => {
  it('核实后对比前后快照，给出被释放的租约标识', async () => {
    let reconcileCount = 0
    const adapter = makeFakeAdapter({
      listResourceLocks: async () => (reconcileCount === 0
        ? [{ id: 'lock-1', runId: 'run-1', operationId: 'op-1', scopeId: 'scope-1', state: 'unknown', claims: [], createdAt: '2026-10-11T07:00:00Z' }]
        : [{ id: 'lock-1', runId: 'run-1', operationId: 'op-1', scopeId: 'scope-1', state: 'released', claims: [], createdAt: '2026-10-11T07:00:00Z', evidence: 'e', decision: 'confirmed-stopped' as const }]),
      reconcileBarrier: async () => {
        reconcileCount += 1
        return { ...BARRIER, status: 'reconciled', decision: 'confirmed-stopped' as const, evidence: 'e', reconciledAt: '2026-10-11T08:00:00Z' }
      },
    })
    const gateway = makeGateway(adapter)
    await useAgentApprovalsStore.getState().loadLocks(gateway)
    const result = await useAgentApprovalsStore.getState().reconcileBarrier(gateway, 'bar-1', { evidence: 'e', decision: 'confirmed-stopped' })
    expect(result?.barrier.status).toBe('reconciled')
    expect(result?.releasedLeaseIds).toEqual(['lock-1'])
  })
})

describe('能力撤销：事实入册与单飞', () => {
  it('成功入册撤销事实；同键并发只发一次', async () => {
    let release: (() => void) | undefined
    let gateFirstCall = true
    let revokeCalls = 0
    const adapter = makeFakeAdapter({
      revokeSkill: async () => {
        revokeCalls += 1
        if (gateFirstCall) {
          gateFirstCall = false
          await new Promise<void>((resolve) => { release = resolve })
        }
        return { revoked: true }
      },
    })
    const gateway = makeGateway(adapter)
    const first = useAgentApprovalsStore.getState().revokeCapability(gateway, 'skill', 'skill-1', 1, '过期')
    const second = await useAgentApprovalsStore.getState().revokeCapability(gateway, 'skill', 'skill-1', 1, '过期')
    expect(second).toBeUndefined()
    release?.()
    await expect(first).resolves.toEqual({ revoked: true })
    expect(useAgentApprovalsStore.getState().revocations).toHaveLength(1)
    expect(revokeCalls).toBe(1)
    // 幂等重复（非并发）不再重复入册。
    await useAgentApprovalsStore.getState().revokeCapability(gateway, 'skill', 'skill-1', 1, '过期')
    expect(useAgentApprovalsStore.getState().revocations).toHaveLength(1)
  })
})

describe('纯选择器', () => {
  it('runId 深链过滤与审批引用标注', () => {
    expect(selectApprovalsByRun([PENDING], 'run-1')).toHaveLength(1)
    expect(selectApprovalsByRun([PENDING], 'run-2')).toHaveLength(0)
    const referenced = collectApprovalReferencedIds([PENDING])
    expect(referenced.has('mcp-1')).toBe(true)
    expect(referenced.has('exec-1')).toBe(true)
    expect(referenced.has('grant-1')).toBe(true)
    expect(referenced.has('builtin')).toBe(false)
  })
})
