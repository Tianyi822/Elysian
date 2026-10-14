import { RUNTIME_RUN_STATUSES, type AgentChatOutput, type AgentMessage, type AgentSession } from '@elysian/contracts'
import type { AgentChatRun, AgentChatTask, AgentChatPageResult, AgentConversationAdapter } from '../../../contracts/agentChat'
import { agentPathPart, readAgentResponse, requestAgentJson, requestAgentNoContent } from './agentShared'
import { SseFrameParser } from '../../sse/parse'
import { fetchWithSession } from '../unauthorized'

const invalid = () => new Error('Agent 会话响应格式无效')
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
const string = (value: unknown): string => { if (typeof value !== 'string') throw invalid(); return value }
const cursor = (value: unknown) => { const result = string(value); if (!/^(0|[1-9]\d*)$/.test(result)) throw invalid(); return result }
const optional = (value: unknown) => value === undefined ? undefined : string(value)

function parseSession(value: unknown): AgentSession {
  const row = object(value)
  if (!Number.isSafeInteger(row.modelRevision) || Number(row.modelRevision) < 1) throw invalid()
  return {
    id: string(row.id), title: string(row.title), createdAt: string(row.createdAt), lastActivityAt: string(row.lastActivityAt),
    modelProfileId: string(row.modelProfileId), modelRevision: Number(row.modelRevision), lastSeq: cursor(row.lastSeq),
    activeRunId: optional(row.activeRunId), activeWorkflowId: optional(row.activeWorkflowId),
  }
}

/** 本地演示没有运行内核，不模拟模型答复。 */
export function createUnavailableAgentConversationAdapter(): AgentConversationAdapter {
  const unavailable = async (): Promise<never> => { throw new Error('当前为本地演示，请在已连接后端的面板中使用聊天。') }
  return { available: false, listSessions: unavailable, listTasks: unavailable, getTask: unavailable, createSession: unavailable, getSession: unavailable, renameSession: unavailable, deleteSession: unavailable, switchModel: unavailable, messages: unavailable, createTask: unavailable, continueTask: unavailable, getRun: unavailable, reasoning: unavailable, stream: unavailable }
}

function parseRun(value: unknown): AgentChatRun {
  const row = object(value)
  if (!(RUNTIME_RUN_STATUSES as readonly unknown[]).includes(row.status)) throw invalid()
  const failure = (value: unknown) => { const entry = object(value); return { code: string(entry.code), message: string(entry.message) } }
  const phases = ['queued', 'inference', 'checkpoint', 'final-memory', 'workflow-output', 'waiting-approval', 'waiting-resource', 'completed']
  if (row.phase !== undefined && !phases.includes(string(row.phase))) throw invalid()
  return {
    id: string(row.id), requestId: optional(row.requestId), taskId: string(row.taskId), sessionId: optional(row.sessionId), status: row.status as AgentChatRun['status'],
    phase: row.phase as AgentChatRun['phase'], cancelRequestedAt: optional(row.cancelRequestedAt),
    error: row.error === undefined ? undefined : failure(row.error), warning: row.warning === undefined ? undefined : failure(row.warning),
  }
}

function parseTask(value: unknown): AgentChatTask {
  const row = object(value)
  const task = { id: string(row.id), sessionId: string(row.sessionId), kind: string(row.kind), latestRun: row.latestRun == null ? undefined : parseRun(row.latestRun) }
  if (task.latestRun && (task.latestRun.taskId !== task.id || task.latestRun.sessionId !== task.sessionId)) throw invalid()
  return task
}

function parsePage<T>(value: unknown, parse: (value: unknown) => T): AgentChatPageResult<T> {
  const row = object(value)
  if (!Array.isArray(row.items) || typeof row.hasMore !== 'boolean') throw invalid()
  const nextCursor = string(row.nextCursor)
  if (row.hasMore && (!nextCursor || !row.items.length)) throw invalid()
  return { items: row.items.map(parse), nextCursor, hasMore: row.hasMore }
}

function parseMessage(value: unknown): AgentMessage {
  const row = object(value)
  if (row.role !== 'user' && row.role !== 'assistant') throw invalid()
  if (row.quarantined !== undefined && typeof row.quarantined !== 'boolean') throw invalid()
  if (row.runStatus !== undefined && !(RUNTIME_RUN_STATUSES as readonly unknown[]).includes(row.runStatus)) throw invalid()
  return {
    id: string(row.id), sessionId: string(row.sessionId), taskId: string(row.taskId), runId: string(row.runId), seq: cursor(row.seq),
    role: row.role, content: string(row.content), createdAt: string(row.createdAt), quarantined: row.quarantined as boolean | undefined,
    runStatus: row.runStatus as AgentMessage['runStatus'],
  }
}

export function createHttpAgentConversationAdapter(): AgentConversationAdapter {
  const path = (id: string) => agentPathPart(id)
  const write = (url: string, body: unknown, method = 'POST') => requestAgentJson(`/api/agent${url}`, { method, body: JSON.stringify(body) })
  return {
    available: true,
    async listSessions(after = '', signal) {
      const query = new URLSearchParams({ sort: 'activity', limit: '50' })
      if (after) query.set('cursor', after)
      return parsePage(await requestAgentJson(`/api/agent/sessions?${query}`, { signal }), parseSession)
    },
    async listTasks(id, after = '', signal) {
      const query = new URLSearchParams({ limit: '50' })
      if (after) query.set('cursor', after)
      const page = parsePage(await requestAgentJson(`/api/agent/sessions/${path(id)}/tasks?${query}`, { signal }), parseTask)
      if (page.items.some(task => task.sessionId !== id)) throw invalid()
      return page
    },
    async getTask(id, signal) {
      const task = parseTask(await requestAgentJson(`/api/agent/tasks/${path(id)}`, { signal }))
      if (task.id !== id) throw invalid()
      return task
    },
    createSession: async input => parseSession(await write('/sessions', input)),
    getSession: async (id, signal) => parseSession(await requestAgentJson(`/api/agent/sessions/${path(id)}`, { signal })),
    renameSession: async (id, input) => parseSession(await write(`/sessions/${path(id)}/title`, input, 'PUT')),
    deleteSession: async id => { await requestAgentNoContent(`/api/agent/sessions/${path(id)}`, { method: 'DELETE' }) },
    switchModel: async (id, input) => parseSession(await write(`/sessions/${path(id)}/model`, input, 'PUT')),
    async messages(id, after, signal) {
      const row = object(await requestAgentJson(`/api/agent/sessions/${path(id)}/messages?after=${cursor(after)}&limit=100`, { signal }))
      if (!Array.isArray(row.items) || typeof row.hasMore !== 'boolean') throw invalid()
      const items = row.items.map(parseMessage)
      const nextCursor = cursor(row.nextCursor)
      let previous = BigInt(after)
      for (const item of items) {
        if (item.sessionId !== id || BigInt(item.seq) <= previous) throw invalid()
        previous = BigInt(item.seq)
      }
      if (BigInt(nextCursor) !== previous || (row.hasMore && !items.length)) throw invalid()
      return { items, nextCursor, hasMore: row.hasMore }
    },
    createTask: async (id, input) => parseRun(await write(`/sessions/${path(id)}/tasks`, input)),
    continueTask: async (id, input) => parseRun(await write(`/tasks/${path(id)}/runs`, input)),
    getRun: async (id, signal) => parseRun(await requestAgentJson(`/api/agent/runs/${path(id)}`, { signal })),
    async stream(id, onOutput, signal) {
      // 复用帧解析器与 401 处理，流断开只重连读取，不重新提交消息。
      const timeout = AbortSignal.timeout(45000)
      const response = await fetchWithSession(`/api/agent/runs/${path(id)}/output`, {
        signal: AbortSignal.any([signal, timeout]), cache: 'no-store', headers: { Accept: 'text/event-stream' },
      })
      if (!response.ok) { await readAgentResponse(response); return }
      if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw invalid()
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parser = new SseFrameParser()
      let unframed = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          unframed += value.byteLength
          if (unframed > 8 * 1024 * 1024) throw invalid()
          const frames = parser.push(decoder.decode(value, { stream: true }))
          if (frames.length) unframed = 0
          for (const frame of frames) {
            if (frame.event !== 'output') continue
            const row = object(JSON.parse(frame.data))
            if (row.runId !== id || typeof row.done !== 'boolean') throw invalid()
            const output: AgentChatOutput = { runId: id, responseId: string(row.responseId), reasoning: string(row.reasoning), content: string(row.content), done: row.done }
            if (signal.aborted) return
            onOutput(output)
            if (output.done) return
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    },
    async reasoning(id, signal) {
      const parts: string[] = []
      let after = '0'
      for (;;) {
        const page = object(await requestAgentJson(`/api/agent/runs/${path(id)}/model-requests?cursor=${after}&limit=50`, { signal }))
        if (!Array.isArray(page.items) || typeof page.hasMore !== 'boolean') throw invalid()
        for (const value of page.items) {
          const record = object(value)
          if (record.runId !== id) throw invalid()
          if (record.purpose !== 'inference') continue
          const response = record.response === undefined ? undefined : object(record.response)
          const text = optional(response?.reasoning) ?? optional(record.reasoning)
          if (text?.trim()) parts.push(text)
        }
        if (!page.hasMore) return parts.join('\n\n')
        const next = cursor(page.nextCursor)
        if (BigInt(next) <= BigInt(after)) throw invalid()
        after = next
      }
    },
  }
}
