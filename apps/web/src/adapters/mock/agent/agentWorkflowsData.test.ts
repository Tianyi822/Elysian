import { beforeEach, describe, expect, it } from 'vitest'
import { runAgentWorkflowsAdapterContract } from '../../agentWorkflowsAdapterContract'
import { WORKFLOW_CONTRACT_RECOVERY_INPUT } from '../../agentWorkflowsFixtures'
import { AgentHttpError } from '../../http/agent/agentShared'
import { AgentWorkflowsMockAdapter } from './agentWorkflowsMockAdapter'
import {
  dataCancelInstance,
  dataCreateInstance,
  dataGetInstance,
  dataListInstanceEvents,
  dataListInstances,
  dataRecoverInstance,
  hasDuplicateJsonKeys,
  nextDecimal,
  resetAgentWorkflowsData,
  setAgentWorkflowBarrierCount,
} from './agentWorkflowsData'

runAgentWorkflowsAdapterContract('mock', () => {
  resetAgentWorkflowsData()
  return new AgentWorkflowsMockAdapter()
})

describe('工作流 mock 数据状态机', () => {
  beforeEach(() => {
    resetAgentWorkflowsData()
  })

  it('nextDecimal 十进制字符串进位不经 number', () => {
    expect(nextDecimal('0')).toBe('1')
    expect(nextDecimal('9')).toBe('10')
    expect(nextDecimal('99')).toBe('100')
    expect(nextDecimal('99999999999999999999')).toBe('100000000000000000000')
  })

  it('hasDuplicateJsonKeys 探测嵌套与转义键', () => {
    expect(hasDuplicateJsonKeys('{"a":1,"a":2}')).toBe(true)
    expect(hasDuplicateJsonKeys('{"a":{"b":1,"b":2}}')).toBe(true)
    expect(hasDuplicateJsonKeys('{"a":1,"b":2}')).toBe(false)
    expect(hasDuplicateJsonKeys('{"a:b":1,"a":2}')).toBe(false)
    expect(hasDuplicateJsonKeys('["x","x"]')).toBe(false)
  })

  it('非终态实例在 getInstance 读取时逐格推进到已完成（v2 join 语义）', () => {
    let instance = dataGetInstance('wf-inst-portal-01')
    const seen: string[] = [instance.status]
    for (let index = 0; index < 30 && instance.status !== 'succeeded' && instance.status !== 'recovery-required'; index += 1) {
      instance = dataGetInstance('wf-inst-portal-01')
      seen.push(instance.status)
    }
    expect(instance.status).toBe('succeeded')
    expect(instance.outputJson).toBe('{"verdict":"门户运行正常"}')
    // parallel 键控对象 / foreach 序号数组的 join 输出可解析验证。
    const tree = dataGetInstance('wf-inst-portal-01').executionTree
    const fanout = tree?.nodes.find((node) => node.id === 'node-fanout')
    const digest = tree?.nodes.find((node) => node.id === 'node-digest')
    expect(fanout?.outputJson !== undefined && Object.hasOwn(JSON.parse(fanout.outputJson), 'logs')).toBe(true)
    expect(digest?.outputJson !== undefined && Array.isArray(JSON.parse(digest.outputJson))).toBe(true)
    // 用量只增不减：成功后不低于种子值。
    expect(instance.usage.modelRequests).toBeGreaterThanOrEqual(6)
  })

  it('取消：非终态先「已请求取消」，下一次读取进入已取消；终态取消幂等回读', () => {
    const requested = dataCancelInstance('wf-inst-portal-01')
    expect(requested.cancelRequestedAt).toBeDefined()
    expect(requested.status).not.toBe('cancelled')
    const list = dataListInstances({})
    const row = list.items.find((item) => item.id === 'wf-inst-portal-01')
    expect(row?.cancelRequestedAt).toBeDefined()
    const after = dataGetInstance('wf-inst-portal-01')
    expect(after.status).toBe('cancelled')
    const again = dataCancelInstance('wf-inst-portal-01')
    expect(again.status).toBe('cancelled')
    expect(again.endedAt).toBe(after.endedAt)
  })

  it('恢复 retry：修订 +1、用量连续、下一次读取产生新尝试且旧尝试不变', () => {
    const before = dataGetInstance('wf-inst-portal-02')
    expect(before.allowedActions).toEqual(['retry', 'accept-result'])
    const usageBefore = { ...before.usage }
    const eventsBefore = dataListInstanceEvents('wf-inst-portal-02', {}).items.length
    const recovered = dataRecoverInstance('wf-inst-portal-02', WORKFLOW_CONTRACT_RECOVERY_INPUT)
    expect(recovered.doc.status).toBe('ready')
    expect(recovered.doc.usage).toEqual(usageBefore)
    expect(recovered.doc.revision).toBe(before.revision + 1)
    expect(dataListInstanceEvents('wf-inst-portal-02', {}).items.length).toBe(eventsBefore + 1)
    // 节点重新推进：analyze 产生第二次尝试，旧尝试记录保持不变。
    let instance = dataGetInstance('wf-inst-portal-02')
    for (let index = 0; index < 30 && instance.status !== 'succeeded' && instance.status !== 'recovery-required'; index += 1) {
      instance = dataGetInstance('wf-inst-portal-02')
    }
    const node = instance.executionTree?.nodes.find((item) => item.id === 'node-analyze-logs-02')
    expect(node?.attempt).toBe(2)
    expect(node?.runId).not.toBe('run-analyze-02')
    if (instance.status === 'recovery-required') {
      // 兄弟失败后成功分支不再推进的兜底：此处不应发生（失败节点已恢复）。
      throw new Error(`实例意外回到恢复态：${instance.error?.code}`)
    }
  })

  it('屏障旋钮：unknown 屏障阻断恢复并清空 allowedActions，复位后恢复可用', () => {
    setAgentWorkflowBarrierCount(1)
    const blocked = dataGetInstance('wf-inst-portal-02')
    expect(blocked.allowedActions).toEqual([])
    expect(() => dataRecoverInstance('wf-inst-portal-02', WORKFLOW_CONTRACT_RECOVERY_INPUT)).toThrowError(AgentHttpError)
    try {
      dataRecoverInstance('wf-inst-portal-02', WORKFLOW_CONTRACT_RECOVERY_INPUT)
    } catch (error) {
      expect((error as AgentHttpError).code).toBe('execution-barrier')
      expect((error as AgentHttpError).message).toBe('必须先核实全部未知执行屏障')
    }
    setAgentWorkflowBarrierCount(0)
    expect(dataGetInstance('wf-inst-portal-02').allowedActions).toEqual(['retry', 'accept-result'])
  })

  it('accept-result：需 outputJson、写入 operator 来源并计入结果预算', () => {
    const before = dataGetInstance('wf-inst-portal-02')
    expect(() =>
      dataRecoverInstance('wf-inst-portal-02', {
        ...WORKFLOW_CONTRACT_RECOVERY_INPUT,
        requestId: 'accept-empty',
        action: 'accept-result',
      }),
    ).toThrowError('补录结果必须提供 outputJson')
    const result = dataRecoverInstance('wf-inst-portal-02', {
      ...WORKFLOW_CONTRACT_RECOVERY_INPUT,
      requestId: 'accept-ok',
      action: 'accept-result',
      outputJson: '{"summary":"外部已核实"}',
    })
    expect(result.doc.status).toBe('ready')
    expect(result.doc.usage.resultBytes).toBe(before.usage.resultBytes + '{"summary":"外部已核实"}'.length)
    // 重新走到恢复态的节点不再有 accept-result 之外的路径被伪造为完成。
    const node = dataGetInstance('wf-inst-portal-02').executionTree?.nodes.find((item) => item.id === 'node-analyze-logs-02')
    expect(node?.status).toBe('succeeded')
  })

  it('恢复的前端防线在数据层复核：evidence 必填、expectedRevision CAS、v2 nodeId 必填', () => {
    expect(() =>
      dataRecoverInstance('wf-inst-portal-02', { ...WORKFLOW_CONTRACT_RECOVERY_INPUT, requestId: 'no-evidence', evidence: '  ' }),
    ).toThrowError('人工恢复必须提供 1 至 8192 字节的核实说明')
    expect(() =>
      dataRecoverInstance('wf-inst-portal-02', { ...WORKFLOW_CONTRACT_RECOVERY_INPUT, requestId: 'old-rev', expectedRevision: 1 }),
    ).toThrowError('工作流状态版本已变化')
    expect(() =>
      dataRecoverInstance('wf-inst-portal-02', { ...WORKFLOW_CONTRACT_RECOVERY_INPUT, requestId: 'no-node', nodeId: undefined }),
    ).toThrowError('恢复 workflow/v2 必须指定 nodeId')
    expect(() =>
      dataRecoverInstance('wf-inst-portal-02', { ...WORKFLOW_CONTRACT_RECOVERY_INPUT, requestId: 'bad-action', action: 'continue' }),
    ).toThrowError('流程不处于可恢复状态')
  })

  it('创建实例：同 requestId 幂等、不同输入 409、停用模板被拒；v1 实例推进停在等待审批', () => {
    const input = {
      requestId: 'create-v1-demo',
      definitionId: 'wf-def-backup',
      definitionRevision: 1,
      sourceSessionId: 'sess-source-demo',
      inputJson: '{"backupId":"bk-1","mode":"full"}',
    }
    const first = dataCreateInstance(input)
    expect(first.duplicate).toBe(false)
    const replay = dataCreateInstance(input)
    expect(replay.duplicate).toBe(true)
    expect(replay.doc.id).toBe(first.doc.id)
    expect(() => dataCreateInstance({ ...input, inputJson: '{"backupId":"bk-2","mode":"full"}' })).toThrowError('相同请求标识对应不同工作流输入')
    expect(() =>
      dataCreateInstance({ ...input, requestId: 'create-disabled', definitionId: 'wf-def-audit', definitionRevision: 3, inputJson: '{}' }),
    ).toThrowError('工作流模板已停用')
    // v1 引擎推进：collect → check → apply → confirm 停在等待审批（不自动批准）。
    let instance = first.doc
    for (let index = 0; index < 20 && instance.status !== 'waiting-approval' && instance.status !== 'succeeded'; index += 1) {
      instance = dataGetInstance(instance.id)
    }
    expect(instance.status).toBe('waiting-approval')
    expect(instance.currentStepId).toBe('confirm')
  })

  it('实例列表：状态过滤与游标分页', () => {
    const running = dataListInstances({ status: 'running' })
    expect(running.items.length).toBe(1)
    expect(running.items[0]?.id).toBe('wf-inst-portal-01')
    const paged = dataListInstances({ limit: 2 })
    expect(paged.items.length).toBe(2)
    expect(paged.hasMore).toBe(true)
    expect(paged.nextCursor).toBe('2')
    const next = dataListInstances({ limit: 2, cursor: '2' })
    expect(next.items[0]?.id).toBe('wf-inst-portal-02')
  })
})
