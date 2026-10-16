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
