import type {
  AgentCreateWorkflowDefinitionInput,
  AgentCreateWorkflowInput,
  AgentWorkflowAttempt,
  AgentWorkflowDefinition,
  AgentWorkflowEvent,
  AgentWorkflowExecutionTree,
  AgentWorkflowInstance,
  AgentWorkflowRecoveryInput,
  AgentWorkflowStatus,
  RuntimePage,
} from '@elysian/contracts'
import type { AgentPageQuery, AgentWorkflowsAdapter } from '../../../contracts/adapters'
import {
  dataCancelInstance,
  dataCreateDefinition,
  dataCreateInstance,
  dataGetDefinition,
  dataGetExecutionTree,
  dataGetInstance,
  dataListAttempts,
  dataListDefinitions,
  dataListInstanceEvents,
  dataListInstances,
  dataRecoverInstance,
  dataUpdateDefinition,
} from './agentWorkflowsData'

/*
 * 工作流域 mock 适配器：确定性数据集与状态机在 agentWorkflowsData.ts，
 * 本类只做接口桥接。resetAgentWorkflowsData 由 test/agentTestUtils 聚合复位，
 * 刷新页面即回到种子状态（AGENTS.md 演示约定）。
 */

export { resetAgentWorkflowsData } from './agentWorkflowsData'

export class AgentWorkflowsMockAdapter implements AgentWorkflowsAdapter {
  async listDefinitions(): Promise<readonly AgentWorkflowDefinition[]> {
    return dataListDefinitions()
  }

  async getDefinition(definitionId: string, revision?: number): Promise<AgentWorkflowDefinition> {
    return dataGetDefinition(definitionId, revision)
  }

  async createDefinition(input: AgentCreateWorkflowDefinitionInput): Promise<AgentWorkflowDefinition> {
    return dataCreateDefinition(input)
  }

  async updateDefinition(
    definitionId: string,
    input: { expectedRevision: number } & AgentCreateWorkflowDefinitionInput,
  ): Promise<AgentWorkflowDefinition> {
    return dataUpdateDefinition(definitionId, input)
  }

  async createInstance(input: AgentCreateWorkflowInput): Promise<AgentWorkflowInstance> {
    return (await dataCreateInstance(input)).doc
  }

  async listInstances(query: { status?: AgentWorkflowStatus; cursor?: string; limit?: number }): Promise<RuntimePage<AgentWorkflowInstance>> {
    return dataListInstances(query)
  }

  async getInstance(instanceId: string): Promise<AgentWorkflowInstance> {
    return dataGetInstance(instanceId)
  }

  async getExecutionTree(instanceId: string): Promise<AgentWorkflowExecutionTree> {
    return dataGetExecutionTree(instanceId)
  }

  async listAttempts(instanceId: string, query?: AgentPageQuery): Promise<RuntimePage<AgentWorkflowAttempt>> {
    return dataListAttempts(instanceId, query ?? {})
  }

  async listInstanceEvents(instanceId: string, query?: AgentPageQuery): Promise<RuntimePage<AgentWorkflowEvent>> {
    return dataListInstanceEvents(instanceId, query ?? {})
  }

  async cancelInstance(instanceId: string): Promise<AgentWorkflowInstance> {
    return dataCancelInstance(instanceId)
  }

  async recoverInstance(instanceId: string, input: AgentWorkflowRecoveryInput): Promise<AgentWorkflowInstance> {
    return (await dataRecoverInstance(instanceId, input)).doc
  }
}
