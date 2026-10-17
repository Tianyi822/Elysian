import { describe, expect, it } from 'vitest'
import { chatTestUserInput } from '../../../test/agentChatFixtures'
import { parseUserInput } from './agentUserInputParse'
import { parseChatTimeline } from './agentChatTimelineParse'

describe('用户选择契约', () => {
  it('恢复结构化待答问题及已提交结果', () => {
    const request = parseUserInput(chatTestUserInput, 'run-1')
    expect(request).toEqual(chatTestUserInput)
    const snapshot = parseChatTimeline({ runId: 'run-1', status: 'waiting-input', done: false, entries: [{
      id: 'm1:tool:c1', kind: 'user-input', modelRequestId: 'm1', modelCallId: 'c1', callId: 'call-1', callIndex: 0, requestIndex: 0, startedAt: '', userInput: request,
    }] }, 'run-1')
    expect(snapshot.entries[0]).toMatchObject({ kind: 'user-input', userInput: request })
  })
  it('拒绝跨运行、重复问题、不完整答案及伪造选项', () => {
    expect(() => parseUserInput(chatTestUserInput, 'other')).toThrow()
    expect(() => parseUserInput({ ...chatTestUserInput, questions: [chatTestUserInput.questions[0], chatTestUserInput.questions[0]] }, 'run-1')).toThrow()
    expect(() => parseUserInput({ ...chatTestUserInput, status: 'answered', answers: { scope: { optionId: 'invalid' } }, answerRequestId: 'answer' }, 'run-1')).toThrow()
    expect(() => parseUserInput({ ...chatTestUserInput, status: 'answered', answers: {}, answerRequestId: 'answer' }, 'run-1')).toThrow()
  })
})
