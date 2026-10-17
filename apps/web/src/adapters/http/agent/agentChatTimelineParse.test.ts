import { describe, expect, it } from 'vitest'
import timelineFixture from '../../../../../../packages/foundation/contracts/fixtures/agent-chat-timeline.json'
import { parseChatTimeline } from './agentChatTimelineParse'

const reasoning = { id: 'm1:reasoning', modelRequestId: 'm1', requestIndex: 0, kind: 'reasoning', text: '思考', startedAt: '', status: 'succeeded', incomplete: false }
const content = { ...reasoning, id: 'm1:content', kind: 'content', text: '正文' }
const tool = { id: 'm1:tool:t', modelRequestId: 'm1', requestIndex: 0, kind: 'tool', tool: 'test', modelCallId: 't', callIndex: 0, argumentsJson: '{"n":9007199254740993}', startedAt: '', status: 'waiting-approval', truncated: false }
const snapshot = { runId: 'r', status: 'waiting-approval', done: false, entries: [reasoning, content, tool] }

describe('时间线响应校验', () => {
  it('保留顺序、精确参数原文与真实状态', () => {
    expect(parseChatTimeline(snapshot, 'r')).toEqual(snapshot)
    expect(parseChatTimeline(snapshot, 'r')).not.toHaveProperty('usage')
    expect(parseChatTimeline(snapshot, 'r')).not.toHaveProperty('contextUsage')
    expect(parseChatTimeline(snapshot, 'r')).not.toHaveProperty('cacheHitUsage')
  })
  it('保留全部累计用量字段及明确零，不补齐未知字段', () => {
    expect(parseChatTimeline(timelineFixture, 'r1')).toEqual(timelineFixture)
    const zero = { calls: 0, resultBytes: 0, modelRequests: 0, tokens: 0, estimatedTokens: 0, actualTokens: 0, cachedTokens: 0 }
    expect(parseChatTimeline({ ...snapshot, usage: zero }, 'r').usage).toEqual(zero)
    const unknown = parseChatTimeline({ ...snapshot, usage: { calls: 0, resultBytes: 0 } }, 'r').usage
    expect(unknown).toEqual({ calls: 0, resultBytes: 0 })
    for (const key of ['modelRequests', 'tokens', 'estimatedTokens', 'actualTokens', 'cachedTokens']) expect(unknown).not.toHaveProperty(key)
    expect(parseChatTimeline({ ...snapshot, usage: { calls: 0, resultBytes: 0, actualTokens: Number.MAX_SAFE_INTEGER } }, 'r').usage?.actualTokens).toBe(Number.MAX_SAFE_INTEGER)
  })
  it('保留运行终态失败原因，缺失时保持未知', () => {
    const failure = { code: 'model-budget', message: '模型请求次数或 token 预算已耗尽' }
    expect(parseChatTimeline({ ...snapshot, error: failure }, 'r').error).toEqual(failure)
    expect(parseChatTimeline(snapshot, 'r')).not.toHaveProperty('error')
    expect(parseChatTimeline(timelineFixture, 'r1')).not.toHaveProperty('error')
  })
  it.each([{ code: 'model-budget' }, { message: '缺编号' }, null, [], 'failed'])('拒绝不完整的失败原因 %j', error => {
    expect(() => parseChatTimeline({ ...snapshot, error }, 'r')).toThrow('格式无效')
  })
  it('保留最后推理的模型快照、未知总量与明确零容量，不依赖可见条目', () => {
    const known = { modelRequestId: 'tool-only', model: 'fixed-model', totalTokens: 12345, contextTokens: 65536 }
    expect(parseChatTimeline({ ...snapshot, entries: [], contextUsage: known }, 'r').contextUsage).toEqual(known)
    const unknown = { modelRequestId: 'm1', model: 'fixed-model', contextTokens: 65536 }
    expect(parseChatTimeline({ ...snapshot, contextUsage: unknown }, 'r').contextUsage).toEqual(unknown)
    expect(parseChatTimeline({ ...snapshot, contextUsage: unknown }, 'r').contextUsage).not.toHaveProperty('totalTokens')
    expect(parseChatTimeline({ ...snapshot, contextUsage: unknown }, 'r').contextUsage).not.toHaveProperty('estimatedBreakdown')
    const zero = { ...unknown, totalTokens: 0, contextTokens: 0 }
    expect(parseChatTimeline({ ...snapshot, contextUsage: zero }, 'r').contextUsage).toEqual(zero)
    const maximum = { ...unknown, totalTokens: Number.MAX_SAFE_INTEGER, contextTokens: Number.MAX_SAFE_INTEGER }
    expect(parseChatTimeline({ ...snapshot, contextUsage: maximum }, 'r').contextUsage).toEqual(maximum)
  })
  it('缓存统计保留同口径输入与命中累计，支持明确零和安全整数边界', () => {
    for (const cacheHitUsage of [{ inputTokens: 10000, cachedTokens: 8210 }, { inputTokens: 0, cachedTokens: 0 }, { inputTokens: Number.MAX_SAFE_INTEGER, cachedTokens: Number.MAX_SAFE_INTEGER }]) {
      expect(parseChatTimeline({ ...snapshot, cacheHitUsage }, 'r').cacheHitUsage).toEqual(cacheHitUsage)
    }
  })
  it.each(['inputTokens', 'cachedTokens'])('缓存统计 %s 只接受非负安全整数', key => {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null]) {
      expect(() => parseChatTimeline({ ...snapshot, cacheHitUsage: { inputTokens: 10000, cachedTokens: 8210, [key]: value } }, 'r')).toThrow('格式无效')
    }
  })
  it.each([null, [], 'cache', {}, { inputTokens: 10000 }, { cachedTokens: 8210 }, { inputTokens: 0, cachedTokens: 1 }, { inputTokens: 100, cachedTokens: 101 }])('拒绝不完整或命中超过输入的缓存统计 %j', cacheHitUsage => {
    expect(() => parseChatTimeline({ ...snapshot, cacheHitUsage }, 'r')).toThrow('格式无效')
  })
  it('完整保留六类估算，零值与未知实测总量互不补齐', () => {
    const estimatedBreakdown = { messages: 0, systemTools: 0, other: 0, skills: 0, systemPrompt: 0, mcpTools: 0 }
    const contextUsage = { modelRequestId: 'm1', model: 'fixed-model', contextTokens: 65536, estimatedBreakdown }
    const parsed = parseChatTimeline({ ...snapshot, contextUsage }, 'r').contextUsage
    expect(parsed).toEqual(contextUsage)
    expect(parsed).not.toHaveProperty('totalTokens')
    const maximum = { ...estimatedBreakdown, messages: Number.MAX_SAFE_INTEGER }
    expect(parseChatTimeline({ ...snapshot, contextUsage: { ...contextUsage, estimatedBreakdown: maximum } }, 'r').contextUsage?.estimatedBreakdown).toEqual(maximum)
  })
  it('各类估算均为安全整数但六项合计超出安全整数范围时拒绝', () => {
    const estimatedBreakdown = { messages: Number.MAX_SAFE_INTEGER, systemTools: 1, other: 0, skills: 0, systemPrompt: 0, mcpTools: 0 }
    const contextUsage = { modelRequestId: 'm1', model: 'fixed-model', contextTokens: 65536, estimatedBreakdown }
    expect(Object.values(estimatedBreakdown).every(Number.isSafeInteger)).toBe(true)
    expect(() => parseChatTimeline({ ...snapshot, contextUsage }, 'r')).toThrow('格式无效')
  })
  it.each(['messages', 'systemTools', 'other', 'skills', 'systemPrompt', 'mcpTools'])('估算 %s 必须存在且为非负安全整数', key => {
    const estimatedBreakdown = timelineFixture.contextUsage.estimatedBreakdown
    const contextUsage = { modelRequestId: 'm1', model: 'fixed-model', contextTokens: 65536 }
    for (const value of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null]) {
      expect(() => parseChatTimeline({ ...snapshot, contextUsage: { ...contextUsage, estimatedBreakdown: { ...estimatedBreakdown, [key]: value } } }, 'r')).toThrow('格式无效')
    }
  })
  it.each([null, [], 'breakdown', {}])('拒绝畸形六类估算 %j', estimatedBreakdown => {
    expect(() => parseChatTimeline({ ...snapshot, contextUsage: { modelRequestId: 'm1', model: 'fixed-model', contextTokens: 65536, estimatedBreakdown } }, 'r')).toThrow('格式无效')
  })
  it.each(['totalTokens', 'contextTokens'])('上下文 %s 只接受非负安全整数', key => {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null]) {
      expect(() => parseChatTimeline({ ...snapshot, contextUsage: { modelRequestId: 'm1', model: 'fixed-model', contextTokens: 65536, [key]: value } }, 'r')).toThrow('格式无效')
    }
  })
  it.each([
    null, [], 'context', {},
    { model: 'fixed-model', contextTokens: 65536 },
    { modelRequestId: '', model: 'fixed-model', contextTokens: 65536 },
    { modelRequestId: 1, model: 'fixed-model', contextTokens: 65536 },
    { modelRequestId: 'm1', contextTokens: 65536 },
    { modelRequestId: 'm1', model: '', contextTokens: 65536 },
    { modelRequestId: 'm1', model: null, contextTokens: 65536 },
    { modelRequestId: 'm1', model: 'fixed-model' },
  ])('拒绝缺失模型快照或畸形上下文用量 %j', contextUsage => {
    expect(() => parseChatTimeline({ ...snapshot, contextUsage }, 'r')).toThrow('格式无效')
  })
  it.each(['calls', 'resultBytes', 'modelRequests', 'tokens', 'estimatedTokens', 'actualTokens', 'cachedTokens'])('用量 %s 只接受非负安全整数', key => {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null]) {
      expect(() => parseChatTimeline({ ...snapshot, usage: { calls: 0, resultBytes: 0, [key]: value } }, 'r')).toThrow('格式无效')
    }
  })
  it.each([null, [], 'usage', {}, { calls: 0 }, { resultBytes: 0 }])('拒绝缺失必填统计或畸形用量 %j', usage => {
    expect(() => parseChatTimeline({ ...snapshot, usage }, 'r')).toThrow('格式无效')
  })
  it.each([
    { ...snapshot, runId: 'other' },
    { ...snapshot, entries: [content, reasoning] },
    { ...snapshot, entries: [content, content] },
    { ...snapshot, entries: [reasoning, { ...content, modelRequestId: 'other' }] },
    { ...snapshot, entries: [{ ...tool, status: 'completed' }] },
    { ...snapshot, finalResponseId: 'internal' },
  ])('拒绝串轮、乱序、重复和未声明的状态', value => {
    expect(() => parseChatTimeline(value, 'r')).toThrow('格式无效')
  })
})
