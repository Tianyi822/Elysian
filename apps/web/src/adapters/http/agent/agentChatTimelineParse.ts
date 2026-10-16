import { RUNTIME_RUN_STATUSES, type AgentChatTimelineEntry, type AgentChatTimelineSnapshot, type AgentChatToolStatus, type RuntimeCall, type RuntimeFailure, type RuntimeJSONValue, type RuntimeRunStatus } from '@elysian/contracts'

const invalid = () => new Error('Agent 时间线响应格式无效')
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
const string = (value: unknown): string => { if (typeof value !== 'string') throw invalid(); return value }
const optional = (value: unknown) => value === undefined ? undefined : string(value)
const integer = (value: unknown): number => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid(); return value }
const boolean = (value: unknown): boolean => { if (typeof value !== 'boolean') throw invalid(); return value }
const status = (value: unknown): RuntimeRunStatus => {
  if (!(RUNTIME_RUN_STATUSES as readonly unknown[]).includes(value)) throw invalid()
  return value as RuntimeRunStatus
}
const failure = (value: unknown): RuntimeFailure | undefined => {
  if (value === undefined) return undefined
  const row = object(value)
  return { code: string(row.code), message: string(row.message) }
}
const toolStatuses: readonly AgentChatToolStatus[] = ['planned', 'waiting-approval', 'waiting-resource', 'waiting-task', 'running', 'succeeded', 'failed', 'cancelled', 'unknown', 'denied', 'expired', 'revoked', 'not-executed']

export function parseChatTimeline(value: unknown, runId: string): AgentChatTimelineSnapshot {
  const row = object(value)
  if (row.runId !== runId || !Array.isArray(row.entries)) throw invalid()
  const seen = new Set<string>()
  const requests = new Map<number, string>()
  let previousIndex = -1
  let previousOrder = -1
  const entries = row.entries.map((value): AgentChatTimelineEntry => {
    const entry = object(value)
    const base = { id: string(entry.id), modelRequestId: string(entry.modelRequestId), requestIndex: integer(entry.requestIndex), startedAt: string(entry.startedAt), endedAt: optional(entry.endedAt) }
    const order = entry.kind === 'reasoning' ? 0 : entry.kind === 'content' ? 1 : 2 + integer(entry.callIndex)
    if (!base.id || !base.modelRequestId || seen.has(base.id) || base.requestIndex < previousIndex ||
      (base.requestIndex === previousIndex && order <= previousOrder) ||
      (requests.has(base.requestIndex) && requests.get(base.requestIndex) !== base.modelRequestId)) throw invalid()
    seen.add(base.id)
    requests.set(base.requestIndex, base.modelRequestId)
    previousIndex = base.requestIndex
    previousOrder = order
    if (entry.kind === 'reasoning' || entry.kind === 'content') {
      return { ...base, kind: entry.kind, text: string(entry.text), status: status(entry.status), incomplete: boolean(entry.incomplete) }
    }
    if (entry.kind !== 'tool' || !(toolStatuses as readonly unknown[]).includes(entry.status)) throw invalid()
    return { ...base, kind: 'tool', tool: string(entry.tool), modelCallId: string(entry.modelCallId), callIndex: integer(entry.callIndex),
      argumentsJson: string(entry.argumentsJson), callId: optional(entry.callId), status: entry.status as AgentChatToolStatus, error: failure(entry.error), truncated: boolean(entry.truncated) }
  })
  const finalResponseId = optional(row.finalResponseId)
  if (finalResponseId && !entries.some(entry => entry.kind === 'content' && entry.modelRequestId === finalResponseId)) throw invalid()
  return { runId, status: status(row.status), done: boolean(row.done), finalResponseId, entries }
}

export function parseChatCall(value: unknown, runId: string): RuntimeCall {
  const row = object(value)
  if (row.runId !== runId) throw invalid()
  return { id: string(row.id), runId, tool: string(row.tool), status: status(row.status), stepIndex: integer(row.stepIndex),
    startedAt: optional(row.startedAt), endedAt: optional(row.endedAt), argumentsJson: optional(row.argumentsJson),
    args: row.args == null ? {} : object(row.args) as Readonly<Record<string, RuntimeJSONValue>>,
    result: row.result as RuntimeJSONValue | undefined, error: failure(row.error), truncated: boolean(row.truncated),
    operationId: optional(row.operationId), modelRequestId: optional(row.modelRequestId), modelCallId: optional(row.modelCallId) }
}
