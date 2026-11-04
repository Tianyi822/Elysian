import type { AgentBudgetStop, AgentContinuation } from '@elysian/contracts'

const invalid = () => new Error('Agent 预算与续接响应格式无效')
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}

export function parseBudgetFields(row: Record<string, unknown>, runId: string) {
  if (row.budgetPolicy !== undefined && row.budgetPolicy !== 'resource-budget/v1') throw invalid()
  const budgetStop: AgentBudgetStop | undefined = row.budgetStop === undefined ? undefined : (() => {
    const stop = object(row.budgetStop)
    if (!['tokens', 'active-time', 'results'].includes(String(stop.resource)) ||
      typeof stop.used !== 'number' || !Number.isSafeInteger(stop.used) || stop.used < 0 ||
      typeof stop.limit !== 'number' || !Number.isSafeInteger(stop.limit) || stop.limit < 1) throw invalid()
    return { resource: stop.resource as AgentBudgetStop['resource'], used: stop.used, limit: stop.limit }
  })()
  const continuation: AgentContinuation | undefined = row.continuation === undefined ? undefined : (() => {
    const next = object(row.continuation)
    if (next.sourceRunId !== runId || typeof next.allowed !== 'boolean' ||
      (next.blockedReason !== undefined && typeof next.blockedReason !== 'string') ||
      (!next.allowed && !next.blockedReason) || (next.allowed && next.blockedReason)) throw invalid()
    return { sourceRunId: runId, allowed: next.allowed, ...(next.blockedReason ? { blockedReason: String(next.blockedReason) } : {}) }
  })()
  return {
    ...(row.budgetPolicy === undefined ? {} : { budgetPolicy: 'resource-budget/v1' as const }),
    ...(budgetStop === undefined ? {} : { budgetStop }),
    ...(continuation === undefined ? {} : { continuation }),
  }
}
