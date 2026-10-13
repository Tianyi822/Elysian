import { vi } from 'vitest'
import type { AgentInput, AgentMessage, AgentModelProfile, AgentSession } from '@elysian/contracts'
import type { AgentChatRun, AgentConversationAdapter } from '../contracts/agentChat'

export const chatTestModel: AgentModelProfile = {
  id: 'model-1', revision: 1, name: '测试模型', model: 'test-model', baseUrl: 'https://model.invalid/v1',
  provider: 'openai-compatible', apiFormat: 'chat-completions', contextTokens: 32768, outputTokens: 4096,
  capabilities: { text: true, tools: true, source: 'manual', reasoningLevels: ['disabled', 'low', 'high', 'max'] }, active: true, hasCredential: true,
}

/** 只在测试中模拟已存在的服务端接口，不进入产品网关。 */
export function chatTestApi() {
  const session: AgentSession = { id: 'server-session', title: '会话', createdAt: '2026-10-12T00:00:00Z', lastActivityAt: '2026-10-12T00:00:00Z', modelProfileId: chatTestModel.id, modelRevision: 1, lastSeq: '0' }
  const messages: AgentMessage[] = []
  const runs = new Map<string, AgentChatRun>()
  const reasoning = new Map<string, string>()
  let hold = false
  const append = (run: AgentChatRun, role: AgentMessage['role'], content: string) => {
    const seq = String(messages.length + 1)
    messages.push({ id: `message-${seq}`, seq, role, content, taskId: run.taskId, runId: run.id, sessionId: session.id, createdAt: session.createdAt })
    session.lastSeq = seq
  }
  const complete = (answer = '你好，我是 Ely。') => {
    const run = runs.get(session.activeRunId!)!
    run.status = 'succeeded'
    run.phase = 'completed'
    append(run, 'assistant', answer)
    session.activeRunId = undefined
  }
  const submit = async (_id: string, input: AgentInput) => {
    const prior = [...runs.values()].find(run => run.requestId === input.requestId)
    if (prior) return { ...prior }
    const run: AgentChatRun = { id: `run-${runs.size + 1}`, taskId: 'task-1', sessionId: session.id, status: 'running', phase: 'inference', requestId: input.requestId }
    runs.set(run.id, run)
    session.activeRunId = run.id
    append(run, 'user', input.content)
    if (!hold) complete()
    return { ...run }
  }
  const api = {
    available: true,
    listSessions: vi.fn(async () => ({ items: runs.size ? [{ ...session }] : [], nextCursor: '', hasMore: false })),
    listTasks: vi.fn(async () => ({ items: runs.size ? [{ id: 'task-1', sessionId: session.id, kind: 'agent' }] : [], nextCursor: '', hasMore: false })),
    getTask: vi.fn(async () => ({ id: 'task-1', sessionId: session.id, kind: 'agent', latestRun: runs.size ? { ...[...runs.values()].at(-1)! } : undefined })),
    createSession: vi.fn(async (input) => { session.modelProfileId = input.modelProfileId; session.modelRevision = input.modelRevision; return { ...session } }),
    getSession: vi.fn(async (_id: string) => ({ ...session })),
    switchModel: vi.fn(async (_id, input) => { session.modelProfileId = input.modelProfileId; session.modelRevision = input.modelRevision; return { ...session } }),
    messages: vi.fn(async (_id, after) => ({ items: messages.filter(message => BigInt(message.seq) > BigInt(after)), nextCursor: session.lastSeq, hasMore: false })),
    createTask: vi.fn(submit), continueTask: vi.fn(submit),
    getRun: vi.fn(async id => ({ ...runs.get(id)! })),
    reasoning: vi.fn(async id => reasoning.get(id) ?? ''),
    stream: vi.fn(async (_id, _onOutput, signal) => {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    }),
  } satisfies AgentConversationAdapter
  return { api, session, messages, runs, reasoning, complete, hold: () => { hold = true } }
}
