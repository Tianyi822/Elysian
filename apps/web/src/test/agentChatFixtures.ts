import { vi } from 'vitest'
import type { AgentChatCacheHitUsage, AgentChatContextUsage, AgentChatTimelineSnapshot, AgentInput, AgentMessage, AgentMessageAttachment, AgentModelProfile, AgentSession, RuntimeCall, RuntimeUsage } from '@elysian/contracts'
import timelineFixture from '../../../../packages/foundation/contracts/fixtures/agent-chat-timeline.json'
import type { AgentChatRun, AgentConversationAdapter } from '../contracts/agentChat'

export const chatTestUsage: RuntimeUsage = timelineFixture.usage
export const chatTestCacheHitUsage: AgentChatCacheHitUsage = timelineFixture.cacheHitUsage

export const chatTestModel: AgentModelProfile = {
  id: 'model-1', revision: 1, model: 'test-model', baseUrl: 'https://model.invalid/v1',
  provider: 'openai-compatible', apiFormat: 'chat-completions', contextTokens: 32768, outputTokens: 4096,
  capabilities: { text: true, tools: true, source: 'manual', reasoningLevels: ['disabled', 'low', 'high', 'max'] }, active: true, hasCredential: true,
}

export const chatTestContextUsage: AgentChatContextUsage = { ...timelineFixture.contextUsage, modelRequestId: 'm1', model: chatTestModel.model, totalTokens: 36200, contextTokens: 100000 }

/** 声明图片输入能力的测试模型：用于附件链路用例。 */
export const chatVisionTestModel: AgentModelProfile = {
  ...chatTestModel,
  id: 'model-vision',
  model: 'test-vision-model',
  capabilities: { ...chatTestModel.capabilities, image: true },
}

/** 只在测试中模拟已存在的服务端接口，不进入产品网关。 */
export function chatTestApi() {
  const session: AgentSession = { id: 'server-session', title: '会话', createdAt: '2026-10-12T00:00:00Z', lastActivityAt: '2026-10-12T00:00:00Z', modelProfileId: chatTestModel.id, modelRevision: 1, lastSeq: '0' }
  const messages: AgentMessage[] = []
  const runs = new Map<string, AgentChatRun>()
  const replacedRuns = new Set<string>()
  const reasoning = new Map<string, string>()
  const timelines = new Map<string, AgentChatTimelineSnapshot>()
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
    if (input.replaceMessageId) {
      const old = messages.find(message => message.id === input.replaceMessageId)
      if (old) replacedRuns.add(old.runId)
    }
    runs.set(run.id, run)
    session.activeRunId = run.id
    append(run, 'user', input.content)
    if (input.attachments?.length) {
      const last = messages.at(-1)!
      last.attachments = input.attachments.map(ref => attachments.get(ref.id)).filter((item): item is NonNullable<typeof item> => !!item)
    }
    if (input.replaceMessageId) messages.at(-1)!.replacesMessageId = messages.find(message => message.id === input.replaceMessageId)?.replacesMessageId ?? input.replaceMessageId
    if (!hold) complete()
    return { ...run }
  }
  const attachments = new Map<string, AgentMessageAttachment>()
  let attachmentSeq = 0
  const api = {
    available: true,
    listSessions: vi.fn(async () => ({ items: runs.size ? [{ ...session }] : [], nextCursor: '', hasMore: false })),
    listTasks: vi.fn(async (_id: string) => ({ items: runs.size ? [{ id: 'task-1', sessionId: session.id, kind: 'agent' }] : [], nextCursor: '', hasMore: false })),
    getTask: vi.fn(async (_id: string) => ({ id: 'task-1', sessionId: session.id, kind: 'agent', latestRun: runs.size ? { ...[...runs.values()].at(-1)! } : undefined })),
    createSession: vi.fn(async (input) => { session.modelProfileId = input.modelProfileId; session.modelRevision = input.modelRevision; return { ...session } }),
    getSession: vi.fn(async (_id: string) => ({ ...session })),
    renameSession: vi.fn(async (_id: string, input: { title: string }) => { session.title = input.title.trim(); return { ...session } }),
    deleteSession: vi.fn(async (_id: string) => {}),
    switchModel: vi.fn(async (_id, input) => { session.modelProfileId = input.modelProfileId; session.modelRevision = input.modelRevision; return { ...session } }),
    messages: vi.fn(async (_id, after) => ({ items: messages.filter(message => !replacedRuns.has(message.runId) && BigInt(message.seq) > BigInt(after)).map((message): AgentMessage => ({ ...message, runStatus: runs.get(message.runId)?.status })), nextCursor: session.lastSeq, hasMore: false })),
    uploadAttachments: vi.fn(async (files: readonly File[]) => ({
      items: files.map(file => {
        const id = `server-attachment-${++attachmentSeq}`
        const item: AgentMessageAttachment = { id, name: file.name, mimeType: file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', bytes: file.size, width: 1, height: 1 }
        attachments.set(id, item)
        return item
      }),
    })),
    attachmentBlob: vi.fn(async (id: string) => {
      if (!attachments.has(id)) throw new Error('附件不存在')
      return new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' })
    }),
    createTask: vi.fn(submit), continueTask: vi.fn(submit),
    getRun: vi.fn(async id => ({ ...runs.get(id)! })),
    cancelRun: vi.fn(async id => {
      const run = runs.get(id)!
      run.status = 'cancelled'
      run.cancelRequestedAt = session.createdAt
      session.activeRunId = undefined
      return { ...run }
    }),
    reasoning: vi.fn(async (id: string, _signal?: AbortSignal) => reasoning.get(id) ?? ''),
    timeline: vi.fn(async (id: string, signal?: AbortSignal): Promise<AgentChatTimelineSnapshot> => {
      if (timelines.has(id)) return timelines.get(id)!
      const text = await api.reasoning(id, signal)
      const run = runs.get(id)
      const response = messages.find(message => message.runId === id && message.role === 'assistant')
      const modelRequestId = `request-${id}`
      const base = { modelRequestId, requestIndex: 0, startedAt: session.createdAt, status: run?.status ?? 'succeeded' }
      return { runId: id, status: base.status, done: !run || ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status),
        finalResponseId: response ? modelRequestId : undefined,
        entries: [...(text ? [{ ...base, id: `${modelRequestId}:reasoning`, kind: 'reasoning' as const, text, incomplete: false }] : []),
          ...(response ? [{ ...base, id: `${modelRequestId}:content`, kind: 'content' as const, text: response.content, incomplete: false }] : [])] }
    }),
    calls: vi.fn(async (): Promise<readonly RuntimeCall[]> => []),
    stream: vi.fn(async (_id, _onOutput, signal) => {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    }),
  } satisfies AgentConversationAdapter
  return { api, session, messages, runs, reasoning, timelines, attachments, complete, hold: () => { hold = true } }
}
