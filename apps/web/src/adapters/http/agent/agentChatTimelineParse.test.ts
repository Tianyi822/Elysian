import { describe, expect, it } from 'vitest'
import { parseChatTimeline } from './agentChatTimelineParse'

const reasoning = { id: 'm1:reasoning', modelRequestId: 'm1', requestIndex: 0, kind: 'reasoning', text: '思考', startedAt: '', status: 'succeeded', incomplete: false }
const content = { ...reasoning, id: 'm1:content', kind: 'content', text: '正文' }
const tool = { id: 'm1:tool:t', modelRequestId: 'm1', requestIndex: 0, kind: 'tool', tool: 'test', modelCallId: 't', callIndex: 0, argumentsJson: '{"n":9007199254740993}', startedAt: '', status: 'waiting-approval', truncated: false }
const snapshot = { runId: 'r', status: 'waiting-approval', done: false, entries: [reasoning, content, tool] }

describe('时间线响应校验', () => {
  it('保留顺序、精确参数原文与真实状态', () => {
    expect(parseChatTimeline(snapshot, 'r')).toEqual(snapshot)
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
