import { describe, expect, it } from 'vitest'
import {
  AGENT_APPROVAL_STATUSES, AGENT_APPROVAL_STATUS_LABELS, AGENT_MCP_PROTOCOL_VERSION,
  AGENT_OPERATION_STATUSES, AGENT_OPERATION_STATUS_LABELS, runtimeRunIsActive,
} from '@elysian/contracts'
import type {
  AgentApproval, AgentCapability, AgentCapabilitySnapshot, AgentContextItem, AgentEnvironment,
  AgentExecutionBarrier, AgentExecutionGrant, AgentExecutionProfile, AgentInput, AgentMCPCatalog,
  AgentMCPServer, AgentMCPServerInput, AgentOperation, AgentSkill, AgentWorkspaceSnapshot,
} from '@elysian/contracts'
import fixture from '../../../../packages/foundation/contracts/fixtures/agent-capabilities.json'

describe('Agent 能力、审批与工作区共享契约', () => {
  it('等待审批仍保持会话忙碌，操作与审批状态均有中文表达', () => {
    expect(runtimeRunIsActive('waiting-approval')).toBe(true)
    expect(Object.keys(AGENT_OPERATION_STATUS_LABELS)).toEqual([...AGENT_OPERATION_STATUSES])
    expect(Object.keys(AGENT_APPROVAL_STATUS_LABELS)).toEqual([...AGENT_APPROVAL_STATUSES])
    for (const label of [...Object.values(AGENT_OPERATION_STATUS_LABELS), ...Object.values(AGENT_APPROVAL_STATUS_LABELS)]) {
      expect(label).toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('固定快照、审批内容和字符串参数与同一共享 fixture 对齐', () => {
    const environment: AgentEnvironment = fixture.environment
    const capability: AgentCapability = fixture.capability
    const operation: AgentOperation = {
      ...fixture.operation, capability, policy: 'approval-required', status: 'waiting-approval',
    }
    const approval: AgentApproval = { ...fixture.approval, status: 'pending', operation }
    const workspace: AgentWorkspaceSnapshot = fixture.workspace
    const barrier: AgentExecutionBarrier = { ...fixture.barrier, status: 'reconciled', decision: 'confirmed-completed' }
    const contextItem: AgentContextItem = fixture.contextItem
    expect({ environment, capability, operation, approval, workspace, barrier, contextItem }).toEqual({
      environment: fixture.environment, capability: fixture.capability, operation: fixture.operation,
      approval: fixture.approval, workspace: fixture.workspace, barrier: fixture.barrier, contextItem: fixture.contextItem,
    })
    expect(operation.argumentsJson).toBe('{"value":9007199254740993}')
    expect(JSON.parse(JSON.stringify(approval)).operation.argumentsJson).toBe(operation.argumentsJson)
    expect(contextItem.eventSeq).toBe('9007199254740993')
    expect(approval.operation.snapshotDigest).toBe(operation.snapshotDigest)
    expect(approval.operation.workspaceRevision).toBe(workspace.revision)
  })

  it('技能、MCP、执行配置和目录授权保持公开投影且可组成受限选择', () => {
    const skill: AgentSkill = { ...fixture.skill, source: { ...fixture.skill.source, kind: 'git' } }
    const mcpServer: AgentMCPServer = { ...fixture.mcpServer, transport: 'streamable-http' }
    const mcpStdioServer: AgentMCPServer = { ...fixture.mcpStdioServer, transport: 'stdio' }
    const mcpCatalog: AgentMCPCatalog = { ...fixture.mcpCatalog, protocolVersion: AGENT_MCP_PROTOCOL_VERSION }
    const executionProfile: AgentExecutionProfile = { ...fixture.executionProfile, runtime: 'python' }
    const grant: AgentExecutionGrant = {
      ...fixture.grant, directories: [{ path: '/srv/example', access: 'ro' }],
      network: [{ scheme: 'https', host: 'example.test', port: 443 }],
    }
    expect({ skill, mcpServer, mcpCatalog, executionProfile, grant }).toEqual({
      skill: fixture.skill, mcpServer: fixture.mcpServer, mcpCatalog: fixture.mcpCatalog,
      executionProfile: fixture.executionProfile, grant: fixture.grant,
    })
    const snapshot: AgentCapabilitySnapshot = {
      environment: fixture.environment, tools: [fixture.capability], digest: 'snapshot-digest',
      skillSummaries: [{ ref: { id: skill.id, revision: skill.revision }, name: skill.manifest.name, description: skill.manifest.description }],
      executionProfiles: [executionProfile], grants: [grant], materials: [],
    }
    const input: AgentInput = {
      requestId: 'selection-1', content: '读取已授权状态', skills: snapshot.environment.skills,
      resources: snapshot.environment.resources,
      prompts: [{ serverId: mcpServer.id, name: 'diagnose', arguments: { subject: '容器' } }],
    }
    expect(input.resources).toEqual(snapshot.environment.resources)
    expect(mcpServer).not.toHaveProperty('credential')
    expect(mcpStdioServer.stdio?.grantId).toBe(grant.id)
    expect(mcpStdioServer.stdio?.grantRevision).toBe(grant.revision)
    expect(mcpStdioServer.stdio).not.toHaveProperty('environment')
    expect(mcpCatalog).not.toHaveProperty('credential')
    expect(snapshot.environment.trustedReadOnly).toEqual([])
    const inputWithSecret: AgentMCPServerInput = {
      name: mcpServer.name, transport: 'streamable-http', url: mcpServer.url,
      active: true, revoked: false, credential: '',
    }
    expect(inputWithSecret.credential).toBe('')
  })
})
