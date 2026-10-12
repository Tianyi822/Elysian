import type {
  AgentApproval,
  AgentApprovalDecisionInput,
  AgentContextItem,
  AgentExecutionBarrier,
  AgentOperation,
  AgentReconciliationInput,
  AgentResourceLease,
  AgentResourceLeaseReconcileInput,
} from '@elysian/contracts'
import type { AgentApprovalsAdapter } from '../../../contracts/adapters'
import {
  agentApprovalsDataApi,
  decideAgentApproval,
  reconcileAgentBarrier,
  reconcileAgentLock,
  revokeAgentCapability,
} from './agentApprovalsData'

/*
 * 审批与治理域 mock：读经确定性数据集（agentApprovalsData.ts），写经同一状态机
 * （同决定幂等、409 decision-conflict、批准后 Run 回 queued、拒绝 failed+stale、
 * 核实联动释放租约），刷新页面即回种子。列表为全量数组不分页，前端过滤。
 * resetAgentApprovalsData 原名再导出，供 test/agentTestUtils 聚合出口使用。
 */

export { resetAgentApprovalsData } from './agentApprovalsData'

export class AgentApprovalsMockAdapter implements AgentApprovalsAdapter {
  async listApprovals(workflowId?: string): Promise<readonly AgentApproval[]> {
    return agentApprovalsDataApi.listApprovals(workflowId)
  }

  async decideApproval(approvalId: string, input: AgentApprovalDecisionInput): Promise<AgentApproval> {
    return decideAgentApproval(approvalId, input.decision)
  }

  async listOperations(runId: string): Promise<readonly AgentOperation[]> {
    return agentApprovalsDataApi.listOperations(runId)
  }

  async listContextItems(runId: string): Promise<readonly AgentContextItem[]> {
    return agentApprovalsDataApi.listContextItems(runId)
  }

  async listBarriers(workflowId?: string): Promise<readonly AgentExecutionBarrier[]> {
    return agentApprovalsDataApi.listBarriers(workflowId)
  }

  async reconcileBarrier(barrierId: string, input: AgentReconciliationInput): Promise<AgentExecutionBarrier> {
    return reconcileAgentBarrier(barrierId, input.evidence, input.decision)
  }

  async listResourceLocks(): Promise<readonly AgentResourceLease[]> {
    return agentApprovalsDataApi.listLocks()
  }

  async reconcileResourceLock(lockId: string, input: AgentResourceLeaseReconcileInput): Promise<AgentResourceLease> {
    return reconcileAgentLock(lockId, input.evidence, input.decision)
  }

  async revokeSkill(skillId: string, revision: number, reason: string): Promise<{ revoked: boolean }> {
    return revokeAgentCapability('skill', skillId, revision, reason)
  }

  async revokeMcpServer(serverId: string, revision: number, reason: string): Promise<{ revoked: boolean }> {
    return revokeAgentCapability('mcp', serverId, revision, reason)
  }

  async revokeExecutionProfile(profileId: string, revision: number, reason: string): Promise<{ revoked: boolean }> {
    return revokeAgentCapability('execution-profile', profileId, revision, reason)
  }

  async revokeGrant(grantId: string, revision: number, reason: string): Promise<{ revoked: boolean }> {
    return revokeAgentCapability('grant', grantId, revision, reason)
  }
}
