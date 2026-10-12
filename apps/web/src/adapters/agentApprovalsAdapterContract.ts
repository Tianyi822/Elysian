import type { AgentApproval, AgentExecutionBarrier, AgentResourceLease } from '@elysian/contracts'
import { AGENT_APPROVAL_STATUSES, AGENT_RESOURCE_LEASE_STATUSES } from '@elysian/contracts'
import { describe, expect, it } from 'vitest'
import type { AgentApprovalsAdapter } from '../contracts/adapters'

/*
 * 审批与治理适配器的可复用断言集合（对齐 logsAdapterContract 先例）：只依赖
 * AgentApprovalsAdapter 接口，不依赖 mock 或 HTTP 的实现细节。mock 实现与
 * HTTP 实现（配状态化 fetch 假服务）对同一套断言各跑一遍——这就是
 * 「mock 可替换」的验证方式。
 *
 * 前提（两种实现都满足）：
 * - make() 返回覆盖「新鲜种子」的适配器（mock 侧先复位数据集，HTTP 侧重建假服务）；
 * - 种子含：≥1 条 pending 的 operation 审批、≥1 条 pending 的工作流闸门审批、
 *   unknown 与 dispatched 与 reconciled 屏障各 ≥1、source=mcp-probe 且 state=unknown
 *   的租约 ≥1、绑定 Run/Operation 的租约 ≥1。
 * 幂等与冲突语义全部由服务端承担（capability_store.go/probe_lifecycle.go），
 * 断言只验证适配器忠实转达。
 */

function isOperationApproval(approval: AgentApproval): approval is Extract<AgentApproval, { operationId: string }> {
  return approval.kind !== 'workflow-gate'
}

export function runAgentApprovalsAdapterContract(name: string, make: () => AgentApprovalsAdapter): void {
  describe(`AgentApprovalsAdapter 契约（${name}）`, () => {
    it('审批列表：全量数组、id 唯一、状态合法、pending/approved 优先于其余状态', async () => {
      const adapter = make()
      const approvals = await adapter.listApprovals()
      expect(Array.isArray(approvals)).toBe(true)
      expect(approvals.length).toBeGreaterThan(0)
      expect(new Set(approvals.map((item) => item.id)).size).toBe(approvals.length)
      let sawOther = false
      for (const approval of approvals) {
        expect(AGENT_APPROVAL_STATUSES).toContain(approval.status)
        expect(Number.isNaN(Date.parse(approval.createdAt))).toBe(false)
        expect(Number.isNaN(Date.parse(approval.expiresAt))).toBe(false)
        if (approval.status !== 'pending' && approval.status !== 'approved') sawOther = true
        else expect(sawOther).toBe(false)
        if (isOperationApproval(approval)) {
          expect(typeof approval.operation.argumentsJson).toBe('string')
          expect(approval.operation.runId).toBe(approval.runId)
        } else {
          expect(approval.kind).toBe('workflow-gate')
          expect(typeof approval.instruction).toBe('string')
          expect(typeof approval.inputJson).toBe('string')
        }
      }
    })

    it('批准闭环：决定后状态推进为 approved；重复同决定幂等；操作参数原文逐字节一致', async () => {
      const adapter = make()
      const approvals = await adapter.listApprovals()
      const target = approvals.find((item) => item.status === 'pending' && isOperationApproval(item))
      expect(target).toBeDefined()
      const decided = await adapter.decideApproval(target!.id, { decision: 'approved' })
      expect(decided.status).toBe('approved')
      expect(decided.decision).toBe('approved')
      expect(decided.decidedAt).toBeDefined()
      const again = await adapter.decideApproval(target!.id, { decision: 'approved' })
      expect(again.status).toBe('approved')
      const operations = await adapter.listOperations(target!.runId)
      const operation = operations.find((item) => item.id === (target as Extract<AgentApproval, { operationId: string }>).operationId)
      expect(operation).toBeDefined()
      expect(operation!.argumentsJson).toBe(
        (target as Extract<AgentApproval, { operationId: string }>).operation.argumentsJson,
      )
    })

    it('冲突语义：已批准后再拒绝被服务端拒绝，错误携带中文信息', async () => {
      const adapter = make()
      const approvals = await adapter.listApprovals()
      const target = approvals.find((item) => item.status === 'pending' && isOperationApproval(item))!
      await adapter.decideApproval(target.id, { decision: 'approved' })
      await expect(adapter.decideApproval(target.id, { decision: 'denied' })).rejects.toThrow()
    })

    it('拒绝闭环：工作流闸门审批可拒绝，状态推进为 denied', async () => {
      const adapter = make()
      const approvals = await adapter.listApprovals()
      const gate = approvals.find((item) => item.status === 'pending' && item.kind === 'workflow-gate')
      expect(gate).toBeDefined()
      const denied = await adapter.decideApproval(gate!.id, { decision: 'denied' })
      expect(denied.status).toBe('denied')
      expect(denied.decision).toBe('denied')
    })

    it('屏障核实：证据为空被拒绝；unknown 屏障核实后关闭并联动释放绑定租约', async () => {
      const adapter = make()
      const barriers = await adapter.listBarriers()
      const unknown = barriers.find((item) => item.status === 'unknown')
      expect(unknown).toBeDefined()
      await expect(adapter.reconcileBarrier(unknown!.id, { evidence: '', decision: 'confirmed-stopped' })).rejects.toThrow('核实证据')
      const beforeLocks = await adapter.listResourceLocks()
      const boundBefore = beforeLocks.find((item) => item.operationId === unknown!.operationId)
      const evidence = '已核对远端容器日志，进程退出码 0，无未完成写入。'
      const reconciled = await adapter.reconcileBarrier(unknown!.id, { evidence, decision: 'confirmed-stopped' })
      expect(reconciled.status).toBe('reconciled')
      expect(reconciled.decision).toBe('confirmed-stopped')
      expect(reconciled.evidence).toBe(evidence)
      const again = await adapter.reconcileBarrier(unknown!.id, { evidence, decision: 'confirmed-stopped' })
      expect(again.status).toBe('reconciled')
      const afterLocks = await adapter.listResourceLocks()
      const boundAfter = afterLocks.find((item) => item.id === boundBefore?.id)
      if (boundBefore !== undefined && boundBefore.state === 'unknown') {
        expect(boundAfter?.state).toBe('released')
        expect(boundAfter?.evidence).toBe(evidence)
      }
    })

    it('屏障冲突：dispatched 屏障不可核实；已核实屏障换决定被拒绝', async () => {
      const adapter = make()
      const barriers = await adapter.listBarriers()
      const dispatched = barriers.find((item) => item.status === 'dispatched')
      expect(dispatched).toBeDefined()
      await expect(
        adapter.reconcileBarrier(dispatched!.id, { evidence: '在途操作没有核实入口。', decision: 'confirmed-stopped' }),
      ).rejects.toThrow('只能核实已标记结果未知的操作')
      const reconciled = barriers.find((item) => item.status === 'reconciled' && item.decision === 'confirmed-stopped')
      if (reconciled !== undefined) {
        await expect(
          adapter.reconcileBarrier(reconciled.id, { evidence: '换一个决定的证据。', decision: 'confirmed-completed' }),
        ).rejects.toThrow('该屏障已有不同核实决定')
      }
    })

    it('租约列表与核实：mcp-probe unknown 可核实且仅此一类；操作租约被拒', async () => {
      const adapter = make()
      const locks = await adapter.listResourceLocks()
      expect(Array.isArray(locks)).toBe(true)
      expect(locks.length).toBeGreaterThan(0)
      expect(new Set(locks.map((item: AgentResourceLease) => item.id)).size).toBe(locks.length)
      for (const lock of locks) {
        expect(AGENT_RESOURCE_LEASE_STATUSES).toContain(lock.state)
        expect(typeof lock.scopeId).toBe('string')
      }
      const probe = locks.find((item) => item.source === 'mcp-probe' && item.state === 'unknown')
      expect(probe).toBeDefined()
      const evidence = 'docker ps 已确认探测容器消失，卷无残留。'
      const released = await adapter.reconcileResourceLock(probe!.id, { evidence, decision: 'confirmed-stopped' })
      expect(released.state).toBe('released')
      expect(released.decision).toBe('confirmed-stopped')
      const again = await adapter.reconcileResourceLock(probe!.id, { evidence, decision: 'confirmed-stopped' })
      expect(again.state).toBe('released')
      await expect(
        adapter.reconcileResourceLock(probe!.id, { evidence: '另一份证据。', decision: 'confirmed-stopped' }),
      ).rejects.toThrow('只能核实停止结果未知的探测租约')
      const operationLease = locks.find((item) => item.source !== 'mcp-probe' && item.state === 'unknown' && item.operationId !== undefined)
      expect(operationLease).toBeDefined()
      await expect(
        adapter.reconcileResourceLock(operationLease!.id, { evidence: '操作租约应走执行屏障。', decision: 'confirmed-stopped' }),
      ).rejects.toThrow('操作租约须通过对应执行屏障核实')
    })

    it('四类能力撤销：原因为空被前端拦截；成功与重复均返回 revoked:true（无 requestId）', async () => {
      const adapter = make()
      await expect(adapter.revokeSkill('skill-demo-ops', 1, '')).rejects.toThrow('撤销原因')
      const cases: ReadonlyArray<[() => Promise<{ revoked: boolean }>, string]> = [
        [() => adapter.revokeSkill('skill-demo-ops', 1, '技能内容过期，撤销后不再可用。'), '技能'],
        [() => adapter.revokeMcpServer('mcp-11111111111111111111111111111111', 2, 'MCP 服务凭据轮换，撤销旧修订。'), 'MCP'],
        [() => adapter.revokeExecutionProfile('exec-python-demo', 1, '执行配置镜像过旧，撤销。'), '执行配置'],
        [() => adapter.revokeGrant('grant-demo-workspace', 1, '授权范围过大，撤销。'), '授权'],
      ]
      for (const [call, label] of cases) {
        await expect(call(), label).resolves.toEqual({ revoked: true })
        await expect(call(), `${label} 重复幂等`).resolves.toEqual({ revoked: true })
      }
    })

    it('workflowId 过滤：审批与屏障都只返回该工作流的条目', async () => {
      const adapter = make()
      const approvals = await adapter.listApprovals()
      const withWorkflow = approvals.find((item) => item.workflowId !== undefined)
      expect(withWorkflow?.workflowId).toBeDefined()
      const filtered = await adapter.listApprovals(withWorkflow!.workflowId)
      expect(filtered.length).toBeGreaterThan(0)
      for (const approval of filtered) expect(approval.workflowId).toBe(withWorkflow!.workflowId)
      const barriers = await adapter.listBarriers()
      const barrierWithWorkflow = barriers.find((item: AgentExecutionBarrier) => item.workflowId !== undefined)
      if (barrierWithWorkflow !== undefined) {
        const filteredBarriers = await adapter.listBarriers(barrierWithWorkflow.workflowId)
        for (const barrier of filteredBarriers) expect(barrier.workflowId).toBe(barrierWithWorkflow.workflowId)
      }
    })

    it('Run 资料列表：数组形状可用（content 原样字符串，eventSeq 保持十进制字符串）', async () => {
      const adapter = make()
      const approvals = await adapter.listApprovals()
      const target = approvals.find((item) => isOperationApproval(item))
      const items = await adapter.listContextItems(target!.runId)
      for (const item of items) {
        expect(typeof item.id).toBe('string')
        expect(typeof item.content).toBe('string')
        expect(typeof item.eventSeq).toBe('string')
        expect(item.runId).toBe(target!.runId)
      }
    })
  })
}
