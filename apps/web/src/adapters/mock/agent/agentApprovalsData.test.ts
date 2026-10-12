import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentApproval } from '@elysian/contracts'
import {
  agentApprovalsDataApi,
  createAgentApprovalsSeed,
  decideAgentApproval,
  readAgentApprovalsRevocations,
  readAgentApprovalsRunFact,
  reconcileAgentBarrier,
  reconcileAgentLock,
  resetAgentApprovalsData,
  revokeAgentCapability,
  setAgentApprovalsClock,
  setAgentApprovalsQueueFull,
} from './agentApprovalsData'

/*
 * 审批与治理 mock 数据集：确定性与状态机语义逐条对齐服务端
 * （capability_store.go 的 Decide/expire/排序、probe_lifecycle.go 的租约核实、
 * materials.go 的撤销）。全部断言基于注入的固定基准时间，不依赖当前时钟。
 */

const BASE = '2026-10-11T08:00:00.000Z'

function findApproval(id: string): AgentApproval | undefined {
  return agentApprovalsDataApi.listApprovals().find((item) => item.id === id)
}

beforeEach(() => {
  resetAgentApprovalsData(BASE)
})

describe('确定性种子', () => {
  it('同基准时间两次生成完全一致', () => {
    expect(JSON.stringify(createAgentApprovalsSeed(BASE))).toBe(JSON.stringify(createAgentApprovalsSeed(BASE)))
  })

  it('pending 审批 24 小时到期；种子覆盖 consumed/denied/expired 全生命周期形态', () => {
    const approvals = agentApprovalsDataApi.listApprovals()
    const statuses = approvals.map((item) => item.status)
    expect(statuses).toContain('pending')
    expect(statuses).toContain('consumed')
    expect(statuses).toContain('denied')
    expect(statuses).toContain('expired')
    const pending = findApproval('ap-pending-write')!
    expect(new Date(pending.expiresAt).getTime() - new Date(pending.createdAt).getTime()).toBe(24 * 3_600_000)
    expect(pending.workflowId).toBe('wf-demo-1')
    if (pending.kind !== 'workflow-gate') {
      expect(pending.operation.argumentsJson).toBe('{"value":9007199254740993,"note":"演示审批参数，原文保留"}')
    } else {
      throw new Error('种子形态异常')
    }
  })

  it('pending/approved 优先于其余状态；workflowId 过滤与 SQL 同口径', () => {
    const approvals = agentApprovalsDataApi.listApprovals()
    const firstOther = approvals.findIndex((item) => item.status !== 'pending' && item.status !== 'approved')
    expect(firstOther).toBeGreaterThan(0)
    expect(approvals.slice(0, firstOther).every((item) => item.status === 'pending' || item.status === 'approved')).toBe(true)
    const filtered = agentApprovalsDataApi.listApprovals('wf-demo-1')
    expect(filtered.length).toBeGreaterThan(0)
    expect(filtered.every((item) => item.workflowId === 'wf-demo-1')).toBe(true)
  })

  it('屏障种子覆盖 unknown/dispatched/reconciled；租约覆盖探测与操作两类', () => {
    const barrierStatuses = agentApprovalsDataApi.listBarriers().map((item) => item.status)
    expect(barrierStatuses).toEqual(expect.arrayContaining(['unknown', 'dispatched', 'reconciled']))
    const locks = agentApprovalsDataApi.listLocks()
    expect(locks.some((item) => item.source === 'mcp-probe' && item.state === 'unknown')).toBe(true)
    expect(locks.some((item) => item.source !== 'mcp-probe' && item.state === 'unknown' && item.operationId !== undefined)).toBe(true)
  })
})

describe('决定审批（对齐 Manager.Decide）', () => {
  it('批准：审批推进 approved，关联 Run 回 queued；重复同决定幂等', () => {
    const decided = decideAgentApproval('ap-pending-write', 'approved')
    expect(decided.status).toBe('approved')
    expect(readAgentApprovalsRunFact('run-pending')?.status).toBe('queued')
    const again = decideAgentApproval('ap-pending-write', 'approved')
    expect(again.status).toBe('approved')
    expect(readAgentApprovalsRunFact('run-pending')?.status).toBe('queued')
  })

  it('拒绝：Run 终态 failed(approval-denied) 且记忆标 stale', () => {
    const decided = decideAgentApproval('ap-gate-confirm', 'denied')
    expect(decided.status).toBe('denied')
    const run = readAgentApprovalsRunFact('run-gate')
    expect(run?.status).toBe('failed')
    expect(run?.endReason).toBe('approval-denied')
    expect(run?.memoryStatus).toBe('stale')
  })

  it('先批准后拒绝：409 decision-conflict，审批保持 approved', () => {
    decideAgentApproval('ap-pending-write', 'approved')
    expect(() => decideAgentApproval('ap-pending-write', 'denied')).toThrow('审批已处理、过期或撤销')
    expect(findApproval('ap-pending-write')?.status).toBe('approved')
  })

  it('队列已满：429 queue-full，审批保持 pending、Run 仍等待审批', () => {
    setAgentApprovalsQueueFull(true)
    expect(() => decideAgentApproval('ap-pending-write', 'approved')).toThrow('任务队列已满，审批保持待处理')
    expect(findApproval('ap-pending-write')?.status).toBe('pending')
    expect(readAgentApprovalsRunFact('run-pending')?.status).toBe('waiting-approval')
  })

  it('过期清扫：时钟越过到期点后 pending 转 expired，Run 终态 approval-expired', () => {
    setAgentApprovalsClock('2026-10-12T09:00:00.000Z')
    const approvals = agentApprovalsDataApi.listApprovals()
    const expired = approvals.find((item) => item.id === 'ap-pending-write')
    expect(expired?.status).toBe('expired')
    const run = readAgentApprovalsRunFact('run-pending')
    expect(run?.status).toBe('recovery-required')
    expect(run?.endReason).toBe('approval-expired')
    expect(run?.memoryStatus).toBe('stale')
  })
})

describe('屏障核实（对齐 Manager.Reconcile）', () => {
  it('unknown 屏障核实关闭并联动释放绑定租约；同证据同决定幂等', () => {
    const evidence = '容器已退出（exit 0），日志完整。'
    const barrier = reconcileAgentBarrier('bar-unknown-script', evidence, 'confirmed-stopped')
    expect(barrier.status).toBe('reconciled')
    const locks = agentApprovalsDataApi.listLocks()
    expect(locks.find((item) => item.id === 'lock-script-unknown')?.state).toBe('released')
    const again = reconcileAgentBarrier('bar-unknown-script', evidence, 'confirmed-stopped')
    expect(again.status).toBe('reconciled')
  })

  it('dispatched 屏障：409 barrier-state-conflict', () => {
    expect(() => reconcileAgentBarrier('bar-dispatched-script', '在途。', 'confirmed-stopped')).toThrow('只能核实已标记结果未知的操作')
  })

  it('已核实屏障换决定：409 decision-conflict；证据越界被拒', () => {
    expect(() => reconcileAgentBarrier('bar-reconciled-script', '换证据。', 'confirmed-completed')).toThrow('该屏障已有不同核实决定')
    expect(() => reconcileAgentBarrier('bar-unknown-script', '', 'confirmed-stopped')).toThrow('必须提供外部核实证据')
    expect(() => reconcileAgentBarrier('bar-unknown-script', '长'.repeat(2734), 'confirmed-stopped')).toThrow('必须提供外部核实证据')
  })
})

describe('租约核实（对齐 Manager.ReconcileProbeLease）', () => {
  it('mcp-probe unknown 核实 confirmed-stopped 后释放；重复同证据幂等', () => {
    const evidence = 'docker ps -a 无该容器。'
    const released = reconcileAgentLock('lock-probe-unknown', evidence, 'confirmed-stopped')
    expect(released.state).toBe('released')
    expect(released.decision).toBe('confirmed-stopped')
    const again = reconcileAgentLock('lock-probe-unknown', evidence, 'confirmed-stopped')
    expect(again.state).toBe('released')
  })

  it('released 后换证据：409 lease-state-conflict；操作租约被拒', () => {
    expect(() => reconcileAgentLock('lock-probe-released', '新证据。', 'confirmed-stopped')).toThrow('只能核实停止结果未知的探测租约')
    expect(() => reconcileAgentLock('lock-script-unknown', '走屏障。', 'confirmed-stopped')).toThrow('操作租约须通过对应执行屏障核实')
  })
})

describe('能力撤销（对齐 Manager.Revoke）', () => {
  it('原因为空被拒；成功与重复均 revoked:true；事实入册不重复', () => {
    expect(() => revokeAgentCapability('skill', 'skill-demo-ops', 1, '')).toThrow('必须提供能力编号、修订和中文撤销原因')
    expect(revokeAgentCapability('skill', 'skill-demo-ops', 1, '内容过期。')).toEqual({ revoked: true })
    expect(revokeAgentCapability('skill', 'skill-demo-ops', 1, '内容过期。')).toEqual({ revoked: true })
    const facts = readAgentApprovalsRevocations().filter((fact) => fact.kind === 'skill' && fact.id === 'skill-demo-ops')
    expect(facts).toHaveLength(1)
    expect(revokeAgentCapability('grant', 'grant-demo-workspace', 1, '范围过大。')).toEqual({ revoked: true })
  })
})
