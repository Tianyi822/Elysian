import { describe, expect, it } from 'vitest'
import { AGENT_WORKFLOW_STATUSES } from '@elysian/contracts'
import type { AgentWorkflowsAdapter } from '../contracts/adapters'
import { compareDecimalCursors, isDecimalCursor } from './http/agent/agentShared'
import {
  WORKFLOW_CONTRACT_CREATE_INPUT,
  WORKFLOW_CONTRACT_DEFINITION_INPUT,
  WORKFLOW_CONTRACT_RECOVERY_INPUT,
  WORKFLOW_DEFINITION_PORTAL,
  WORKFLOW_INSTANCE_PORTAL_RECOVERY,
  workflowStatusIsTerminal,
} from './agentWorkflowsFixtures'

/*
 * 工作流 adapter 的可复用契约断言（照 sessionAdapterContract 先例）：只依赖
 * AgentWorkflowsAdapter 接口本身，对 mock 与 HTTP 两个实现跑同一套——这就是
 * 「mock 可替换」的验证方式。确定性 fixture 在 agentWorkflowsFixtures.ts，
 * mock 种子以其为初始状态、HTTP 测试以其为响应体。
 */

/**
 * 工作流 adapter 契约断言。make 应返回隔离的实现实例（mock 侧先复位种子数据，
 * HTTP 侧先安装预置响应的 fetch stub）；断言覆盖读取形状、分页、CAS、幂等与恢复语义。
 */
export function runAgentWorkflowsAdapterContract(name: string, make: () => AgentWorkflowsAdapter): void {
  describe(`${name} 工作流 adapter 契约`, () => {
    it('listDefinitions 返回确定性模板列表：v1 与 workflow/v2 并存且字段齐全', async () => {
      const definitions = await make().listDefinitions()
      expect(Array.isArray(definitions)).toBe(true)
      expect(definitions.length).toBeGreaterThanOrEqual(3)
      const versions = definitions.map((item) => item.languageVersion ?? 'v1')
      expect(versions).toContain('v1')
      expect(versions).toContain('workflow/v2')
      for (const item of definitions) {
        expect(typeof item.id).toBe('string')
        expect(item.revision).toBeGreaterThan(0)
        expect(typeof item.name).toBe('string')
        expect(typeof item.enabled).toBe('boolean')
        expect(typeof item.goal).toBe('string')
        expect(item.steps.length).toBeGreaterThanOrEqual(1)
        expect(item.steps.length).toBeLessThanOrEqual(32)
      }
      const portal = definitions.find((item) => item.id === 'wf-def-portal')
      expect(portal?.revision).toBe(2)
      expect(portal?.enabled).toBe(true)
    })

    it('getDefinition 读最新修订，未知模板拒绝', async () => {
      const adapter = make()
      const latest = await adapter.getDefinition('wf-def-portal')
      expect(latest.id).toBe('wf-def-portal')
      expect(latest.revision).toBe(2)
      const exact = await adapter.getDefinition('wf-def-portal', 1)
      expect(exact.revision).toBe(1)
      await expect(adapter.getDefinition('wf-def-missing')).rejects.toThrow()
    })

    it('listInstances 首页含运行中与恢复中实例，lastSeq 为十进制字符串', async () => {
      const result = await make().listInstances({})
      expect(result.items.length).toBeGreaterThanOrEqual(4)
      for (const item of result.items) {
        expect(AGENT_WORKFLOW_STATUSES.includes(item.status)).toBe(true)
        expect(isDecimalCursor(item.lastSeq)).toBe(true)
        expect(Array.isArray(item.allowedActions)).toBe(true)
      }
      expect(result.items.some((item) => item.status === 'running')).toBe(true)
      expect(result.items.some((item) => item.status === 'recovery-required')).toBe(true)
      expect(result.items.some((item) => item.status === 'succeeded')).toBe(true)
    })

    it('getInstance 返回恢复中实例：allowedActions 只含服务端认可的动作', async () => {
      const instance = await make().getInstance('wf-inst-portal-02')
      expect(instance.status).toBe('recovery-required')
      expect(instance.languageVersion).toBe('workflow/v2')
      expect(instance.allowedActions).toEqual(['retry', 'accept-result'])
      expect(instance.error?.code).toBe('model-request-failed')
    })

    it('getExecutionTree 呈现 parallel/foreach 分支作用域且节点引用一致', async () => {
      const tree = await make().getExecutionTree('wf-inst-portal-01')
      expect(tree.rootScopeId).toBe('scope-root-01')
      const kinds = tree.scopes.map((scope) => scope.kind)
      expect(kinds).toContain('root')
      expect(kinds).toContain('parallel')
      expect(kinds).toContain('foreach')
      const scopeIds = new Set(tree.scopes.map((scope) => scope.id))
      expect(scopeIds.has(tree.rootScopeId)).toBe(true)
      for (const scope of tree.scopes) {
        if (scope.parentScopeId !== undefined) expect(scopeIds.has(scope.parentScopeId)).toBe(true)
      }
      for (const node of tree.nodes) {
        expect(scopeIds.has(node.scopeId)).toBe(true)
        expect(node.attempt).toBeLessThanOrEqual(3)
        expect(typeof node.stableKey).toBe('string')
      }
      const compound = tree.nodes.filter((node) => node.kind === 'parallel' || node.kind === 'foreach')
      expect(compound.some((node) => node.expanded)).toBe(true)
      const foreachScopes = tree.scopes.filter((scope) => scope.kind === 'foreach')
      expect(foreachScopes.map((scope) => scope.ordinal)).toEqual([0, 1])
    })

    it('listAttempts 分页返回尝试原文：v2 携带 scopeId/nodeId', async () => {
      const result = await make().listAttempts('wf-inst-portal-01')
      expect(result.items.length).toBeGreaterThanOrEqual(3)
      for (const attempt of result.items) {
        expect(attempt.number).toBeGreaterThanOrEqual(1)
        expect(typeof attempt.inputJson).toBe('string')
        if (attempt.outputJson !== undefined) expect(typeof attempt.outputJson).toBe('string')
        expect(typeof attempt.workspaceRevision).toBe('number')
        expect(typeof attempt.scopeId).toBe('string')
        expect(typeof attempt.nodeId).toBe('string')
      }
    })

    it('listInstanceEvents 分页 seq 严格递增（十进制字符串比较）', async () => {
      const result = await make().listInstanceEvents('wf-inst-portal-01')
      expect(result.items.length).toBeGreaterThanOrEqual(4)
      for (let index = 1; index < result.items.length; index += 1) {
        const before = result.items[index - 1]?.seq
        const after = result.items[index]?.seq
        if (before === undefined || after === undefined) throw new Error('事件序号缺失')
        expect(isDecimalCursor(before)).toBe(true)
        expect(compareDecimalCursors(before, after)).toBeLessThan(0)
        expect(typeof result.items[index]?.type).toBe('string')
      }
    })

    it('cancelInstance 对终态实例幂等回读：状态不变', async () => {
      const instance = await make().cancelInstance('wf-inst-backup-01')
      expect(instance.status).toBe('succeeded')
      expect(instance.endedAt).toBeDefined()
    })

    it('recoverInstance 按请求体恢复：修订 +1、状态离开恢复中、预算用量保持连续', async () => {
      const adapter = make()
      const recovered = await adapter.recoverInstance('wf-inst-portal-02', WORKFLOW_CONTRACT_RECOVERY_INPUT)
      expect(recovered.revision).toBe(WORKFLOW_INSTANCE_PORTAL_RECOVERY.revision + 1)
      expect(recovered.status).toBe('ready')
      expect(workflowStatusIsTerminal(recovered.status)).toBe(false)
      expect(recovered.usage).toEqual(WORKFLOW_INSTANCE_PORTAL_RECOVERY.usage)
      const replay = await adapter.recoverInstance('wf-inst-portal-02', WORKFLOW_CONTRACT_RECOVERY_INPUT)
      expect(replay.revision).toBe(recovered.revision)
      expect(replay.id).toBe(recovered.id)
    })

    it('createInstance 同 requestId 幂等：两次返回同一实例', async () => {
      const adapter = make()
      const first = await adapter.createInstance(WORKFLOW_CONTRACT_CREATE_INPUT)
      expect(first.requestId).toBe('contract-create-1')
      expect(first.definitionId).toBe('wf-def-backup')
      expect(workflowStatusIsTerminal(first.status)).toBe(false)
      const second = await adapter.createInstance(WORKFLOW_CONTRACT_CREATE_INPUT)
      expect(second.id).toBe(first.id)
      expect(second.revision).toBe(first.revision)
      await expect(
        adapter.createInstance({
          ...WORKFLOW_CONTRACT_CREATE_INPUT,
          inputJson: '{"backupId":"bk-其他","mode":"full"}',
        }),
      ).rejects.toThrow('相同请求标识对应不同工作流输入')
    })

    it('createDefinition 接受合法 v1 模板并返回修订 1', async () => {
      const created = await make().createDefinition(WORKFLOW_CONTRACT_DEFINITION_INPUT)
      expect(created.revision).toBe(1)
      expect(created.name).toBe('契约新建模板')
      expect(created.steps.length).toBe(1)
    })

    it('createDefinition 拒绝 v1 复合步骤字段并透传中文错误', async () => {
      await expect(
        make().createDefinition({
          ...WORKFLOW_CONTRACT_DEFINITION_INPUT,
          steps: [
            {
              id: 'compound',
              kind: 'agent',
              instruction: '非法复合',
              input: { literalJson: '{}' },
              outputSchemaJson: '{"type":"object"}',
              parallel: { join: 'all', branches: [] },
            },
          ],
        }),
      ).rejects.toThrow('workflow/v1 不能包含复合步骤字段')
    })

    it('updateDefinition 的 expectedRevision CAS：冲突透传「工作流模板版本已变化」，成功返回新修订', async () => {
      const adapter = make()
      await expect(
        adapter.updateDefinition('wf-def-portal', {
          ...WORKFLOW_CONTRACT_DEFINITION_INPUT,
          expectedRevision: 1,
        }),
      ).rejects.toThrow('工作流模板版本已变化')
      const updated = await adapter.updateDefinition('wf-def-portal', {
        goal: '并行诊断门户容器异常并汇总结论（修订目标）',
        name: WORKFLOW_DEFINITION_PORTAL.name,
        enabled: true,
        inputSchemaJson: WORKFLOW_DEFINITION_PORTAL.inputSchemaJson,
        outputSchemaJson: WORKFLOW_DEFINITION_PORTAL.outputSchemaJson,
        entry: WORKFLOW_DEFINITION_PORTAL.entry,
        steps: WORKFLOW_DEFINITION_PORTAL.steps,
        languageVersion: 'workflow/v2',
        expectedRevision: 2,
      })
      expect(updated.revision).toBe(3)
      expect(updated.goal).toBe('并行诊断门户容器异常并汇总结论（修订目标）')
    })

    it('未知实例的读取与恢复都拒绝', async () => {
      const adapter = make()
      await expect(adapter.getInstance('wf-inst-missing')).rejects.toThrow()
      await expect(
        adapter.recoverInstance('wf-inst-missing', WORKFLOW_CONTRACT_RECOVERY_INPUT),
      ).rejects.toThrow()
    })
  })
}
