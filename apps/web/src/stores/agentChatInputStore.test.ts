import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentChatTimelineSnapshot } from '@elysian/contracts'
import { createAgentChatStore } from './agentChatStore'
import { createAgentChatLocalAdapter } from '../adapters/local/agentChatLocalAdapter'
import { chatTestApi, chatTestModel, chatTestUserInput } from '../test/agentChatFixtures'

beforeEach(() => localStorage.clear())
async function setup() {
  const local = createAgentChatLocalAdapter()
  const store = createAgentChatStore(local)
  const backend = chatTestApi(); backend.hold()
  await store.getState().ensureSession()
  store.getState().setDraft('需要确认查询范围')
  await store.getState().send(backend.api, chatTestModel)
  backend.runs.get('run-1')!.status = 'waiting-input'
  backend.runs.get('run-1')!.phase = 'waiting-input'
  const timeline: AgentChatTimelineSnapshot = { runId: 'run-1', status: 'waiting-input', done: false, entries: [
    { id: 'question-entry', kind: 'user-input', modelRequestId: 'm1', requestIndex: 0, startedAt: '', userInput: chatTestUserInput },
  ] }
  backend.timelines.set('run-1', timeline)
  await store.getState().refresh(backend.api)
  store.getState().setDraft('独立消息草稿')
  store.getState().setUserInputAnswer(chatTestUserInput, 'scope', { optionId: 'panel' })
  store.getState().setUserInputAnswer(chatTestUserInput, 'period', { text: '最近一次采样' })
  return { local, store, backend, timeline }
}

describe('用户选择提交与恢复', () => {
  it('刷新恢复未提交答案，并与普通消息草稿隔离', async () => {
    const { store, backend } = await setup()
    const restored = createAgentChatStore(createAgentChatLocalAdapter())
    await restored.getState().initialize(backend.api, backend.session.id)
    expect(restored.getState().session?.userInput?.answers).toEqual(store.getState().session?.userInput?.answers)
    expect(restored.getState().session?.draft).toBe('独立消息草稿')
    expect(restored.getState().run?.status).toBe('waiting-input')
  })
  it('网络失败保留原请求编号，回读未确认时人工重试一次', async () => {
    const { store, backend } = await setup()
    backend.api.answerUserInput.mockRejectedValueOnce(new Error('连接中断'))
    await store.getState().answerUserInput(backend.api, chatTestUserInput)
    const pending = store.getState().session?.userInput?.pending
    expect(pending).toBeDefined()
    store.getState().setUserInputAnswer(chatTestUserInput, 'scope', { optionId: 'system' })
    expect(store.getState().session?.userInput?.answers.scope).toEqual({ optionId: 'panel' })
    backend.api.answerUserInput.mockImplementation(async (_runId, _inputId, input) => ({ userInput: { ...chatTestUserInput, status: 'answered', answers: input.answers, answerRequestId: input.requestId }, run: { ...backend.runs.get('run-1')!, status: 'queued' } }))
    await store.getState().answerUserInput(backend.api, chatTestUserInput)
    expect(backend.api.answerUserInput).toHaveBeenNthCalledWith(2, 'run-1', 'question-1', pending)
    expect(store.getState().session?.userInput).toBeUndefined()
    expect(store.getState().session?.draft).toBe('独立消息草稿')
  })
  it('丢失回执但回读已回答时不重复提交', async () => {
    const { store, backend, timeline } = await setup()
    backend.api.answerUserInput.mockImplementation(async (_runId, _inputId, input) => {
      backend.timelines.set('run-1', { ...timeline, status: 'queued', entries: [{ ...timeline.entries[0]!, kind: 'user-input', userInput: { ...chatTestUserInput, status: 'answered', answers: input.answers, answerRequestId: input.requestId } }] })
      throw new Error('回执丢失')
    })
    await store.getState().answerUserInput(backend.api, chatTestUserInput)
    expect(store.getState().session?.userInput).toBeUndefined()
    expect(backend.api.answerUserInput).toHaveBeenCalledOnce()
    store.getState().clearDisplay()
    expect(store.getState().timelines).toEqual({})
    expect(store.getState().run).toBeNull()
  })
  it('提交在途拒绝重复点击，登出后迟到回执不回灌', async () => {
    const { store, backend } = await setup()
    let release!: () => void
    backend.api.answerUserInput.mockImplementation(async (_runId, _inputId, input) => {
      await new Promise<void>(resolve => { release = resolve })
      return { userInput: { ...chatTestUserInput, status: 'answered', answers: input.answers, answerRequestId: input.requestId }, run: { ...backend.runs.get('run-1')!, status: 'queued' } }
    })
    const submit = store.getState().answerUserInput(backend.api, chatTestUserInput)
    await store.getState().answerUserInput(backend.api, chatTestUserInput)
    expect(backend.api.answerUserInput).toHaveBeenCalledOnce()
    store.getState().clearDisplay()
    release(); await submit
    expect(store.getState().run).toBeNull()
    expect(store.getState().timelines).toEqual({})
  })
})
