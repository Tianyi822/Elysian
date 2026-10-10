import { describe, expect, it } from 'vitest'
import {
  AGENT_WORKFLOW_CONDITION_OPERATORS, AGENT_WORKFLOW_STATUSES, AGENT_WORKFLOW_STATUS_LABELS,
  AGENT_WORKFLOW_STEP_KINDS, AGENT_WORKFLOW_STEP_KIND_LABELS,
  AGENT_WORKFLOW_RECOVERY_ACTIONS, AGENT_WORKFLOW_RECOVERY_ACTION_LABELS,
} from '@elysian/contracts'
import type {
  AgentCreateWorkflowInput, AgentExecutionBarrier, AgentOperation, AgentWorkflowApproval,
  AgentWorkflowAttempt, AgentWorkflowBinding, AgentWorkflowDefinition, AgentWorkflowEvent,
  AgentWorkflowInstance, AgentWorkflowRecoveryInput, AgentWorkflowStepDefinition, RuntimeRun,
} from '@elysian/contracts'
import fixture from '../../../../packages/foundation/contracts/fixtures/agent-workflow.json'

describe('工作流共享契约', () => {
  it('七种节点和持久状态均有完整中文标签', () => {
    expect(AGENT_WORKFLOW_STEP_KINDS).toEqual(['agent', 'operation', 'approval', 'condition', 'parallel', 'foreach', 'subworkflow'])
    expect(Object.keys(AGENT_WORKFLOW_STEP_KIND_LABELS)).toEqual([...AGENT_WORKFLOW_STEP_KINDS])
    expect(Object.keys(AGENT_WORKFLOW_STATUS_LABELS)).toEqual([...AGENT_WORKFLOW_STATUSES])
    for (const label of [...Object.values(AGENT_WORKFLOW_STEP_KIND_LABELS), ...Object.values(AGENT_WORKFLOW_STATUS_LABELS)]) {
      expect(label).toMatch(/[\u4e00-\u9fff]/)
    }
    expect(AGENT_WORKFLOW_CONDITION_OPERATORS).toEqual(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'and', 'or', 'not', 'exists'])
    expect(Object.keys(AGENT_WORKFLOW_RECOVERY_ACTION_LABELS)).toEqual([...AGENT_WORKFLOW_RECOVERY_ACTIONS])
  })

  it('Go共用模板固定步骤输入、输出和大整数原文', () => {
    const [inspect, review] = fixture.definition.steps
    if (!inspect || !review) throw new Error('共享样例缺少读取与审批步骤')
    const steps: readonly AgentWorkflowStepDefinition[] = [
      { id: inspect.id, kind: 'operation', capability: inspect.capability, input: { object: {} }, outputSchemaJson: inspect.outputSchemaJson, next: inspect.next },
      { id: review.id, kind: 'approval', instruction: review.instruction, input: { step: { stepId: 'inspect', pointer: '' } }, outputSchemaJson: review.outputSchemaJson,
        finish: { object: { serial: { input: '/serial' }, approved: { step: { stepId: 'review', pointer: '/approved' } } } } },
    ]
    const definition: AgentWorkflowDefinition = { ...fixture.definition, steps }
    expect(definition).toEqual(fixture.definition)
    expect(JSON.parse(JSON.stringify(fixture)).inputJson).toBe('{"serial":9007199254740993}')
    expect(fixture.expectedOutputJson).toBe('{"approved":true,"serial":9007199254740993}')
    const bindings: readonly AgentWorkflowBinding[] = [{ literalJson: '9007199254740993' }, { object: {} }, { array: [] }, { input: '' }]
    expect(JSON.parse(JSON.stringify(bindings))).toEqual(bindings)
  })

  it('持久实例、步骤尝试、恢复输入和冻结运行与Go保持同一字段', () => {
    const instance: AgentWorkflowInstance = { ...fixture.instance, status: 'recovery-required', allowedActions: [...AGENT_WORKFLOW_RECOVERY_ACTIONS] }
    const attempt: AgentWorkflowAttempt = { ...fixture.attempt, status: 'succeeded' }
    const event: AgentWorkflowEvent = fixture.event
    const create: AgentCreateWorkflowInput = fixture.create
    const recovery: AgentWorkflowRecoveryInput = { ...fixture.recovery, action: 'accept-result' }
    const run: RuntimeRun = { ...fixture.run, status: 'interrupted', workflowFrozenFrom: 'waiting-approval', phase: 'completed', memoryStatus: 'updated', task: { ...fixture.run.task, kind: 'workflow', steps: [] } }
    const operation: AgentOperation = { ...fixture.operation, policy: 'approval-required', status: 'waiting-approval' }
    const approval: AgentWorkflowApproval = { ...fixture.approval, kind: 'workflow-gate', status: 'pending' }
    const barrier: AgentExecutionBarrier = { ...fixture.barrier, status: 'reconciled', decision: 'confirmed-completed' }
    expect({ instance, attempt, event, create, recovery, run, operation, approval, barrier }).toEqual({
      instance: fixture.instance, attempt: fixture.attempt, event: fixture.event, create: fixture.create,
      recovery: fixture.recovery, run: fixture.run, operation: fixture.operation, approval: fixture.approval, barrier: fixture.barrier,
    })
    expect(approval).not.toHaveProperty('operation')
    expect(approval).not.toHaveProperty('operationId')
    expect(JSON.parse(JSON.stringify(instance)).inputJson).toBe('{"serial":9007199254740993}')
    expect(attempt.eventSeq).toBe('9007199254740993')
    expect(run.workflowFrozenFrom).toBe('waiting-approval')
  })
})
