import { runAgentApprovalsAdapterContract } from './agentApprovalsAdapterContract'
import { AgentApprovalsMockAdapter, resetAgentApprovalsData } from './mock/agent/agentApprovalsMockAdapter'

/*
 * AgentApprovalsAdapter 契约断言对 mock 实现复跑（对齐 logsAdapter.mock.test.ts 先例）：
 * 每个用例经 make() 复位回固定基准时间的新鲜种子，用例之间互不影响。
 */

const BASE = '2026-10-11T08:00:00.000Z'

runAgentApprovalsAdapterContract('mock', () => {
  resetAgentApprovalsData(BASE)
  return new AgentApprovalsMockAdapter()
})
