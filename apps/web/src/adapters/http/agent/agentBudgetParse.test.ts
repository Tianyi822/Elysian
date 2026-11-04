import { describe, expect, it } from 'vitest'
import { parseBudgetFields } from './agentBudgetParse'

describe('预算与续接契约', () => {
  it('保留旧响应缺省与旧失败续接能力', () => {
    expect(parseBudgetFields({}, 'old')).toEqual({})
    expect(parseBudgetFields({ continuation: { sourceRunId: 'old', allowed: true } }, 'old')).toEqual({ continuation: { sourceRunId: 'old', allowed: true } })
  })
  it.each(['tokens', 'active-time', 'results'])('解析 %s 与阻塞原因', resource => {
    const data = { budgetPolicy: 'resource-budget/v1', budgetStop: { resource, used: 123, limit: 456 }, continuation: { sourceRunId: 'r', allowed: false, blockedReason: '请先核实未知结果' } }
    expect(parseBudgetFields(data, 'r')).toEqual(data)
  })
  it.each([
    { budgetPolicy: 'unknown' }, { budgetStop: { resource: 'calls', used: 16, limit: 16 } },
    { budgetStop: { resource: 'tokens', used: -1, limit: 1 } }, { budgetStop: { resource: 'tokens', used: 0, limit: 0 } },
    { continuation: { sourceRunId: 'foreign', allowed: true } }, { continuation: { sourceRunId: 'r', allowed: false } },
    { continuation: { sourceRunId: 'r', allowed: true, blockedReason: '不允许' } },
  ])('拒绝损坏元数据 %j', data => { expect(() => parseBudgetFields(data, 'r')).toThrow('预算与续接响应格式无效') })
})
