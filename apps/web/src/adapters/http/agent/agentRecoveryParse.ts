import type { AgentExecutionEvidence, AgentRecovery, AgentRunReport, AgentToolAttempt, RuntimeFailure } from '@elysian/contracts'

const invalid = () => new Error('Agent 恢复记录格式无效')
const object = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(); return v as Record<string, unknown> }
const string = (v: unknown): string => { if (typeof v !== 'string') throw invalid(); return v }
const integer = (v: unknown): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw invalid(); return v }
export function parseExecutionEvidence(value: unknown): AgentExecutionEvidence {
  const e = object(value)
  for (const [key, allowed] of Object.entries({ execution: ['not-started', 'finished', 'unknown'], changes: ['none', 'confirmed', 'unknown'], recovery: ['correct', 'retry', 'verify', 'stop'] })) {
    if (e[key] !== undefined && !allowed.includes(string(e[key]))) throw invalid()
  }
  return { execution: e.execution as AgentExecutionEvidence['execution'], changes: e.changes as AgentExecutionEvidence['changes'], recovery: e.recovery as AgentExecutionEvidence['recovery'], ...(e.stage === undefined ? {} : { stage: string(e.stage) }), ...(e.suggestion === undefined ? {} : { suggestion: string(e.suggestion) }) }
}
export function parseRecoveryFailure(v: unknown): RuntimeFailure | undefined {
  if (v === undefined) return undefined
  const row = object(v)
  return { code: string(row.code), message: string(row.message), ...(row.evidence === undefined ? {} : { evidence: parseExecutionEvidence(row.evidence) }) }
}
export function parseRecovery(v: unknown): AgentRecovery {
  const row = object(v)
  if (!['verifying', 'recovered', 'unresolved', 'correcting', 'exhausted'].includes(string(row.status))) throw invalid()
  return { operationId: string(row.operationId), tool: string(row.tool), startedAt: string(row.startedAt), deadline: string(row.deadline), checks: integer(row.checks), status: row.status as AgentRecovery['status'], message: string(row.message), ...(row.nextCheckAt === undefined ? {} : { nextCheckAt: string(row.nextCheckAt) }) }
}
export function parseAttempts(v: unknown): readonly AgentToolAttempt[] {
  if (!Array.isArray(v) || v.length > 3) throw invalid()
  return v.map(item => { const row = object(item); const number = integer(row.number); if (number < 1 || number > 3) throw invalid(); return { number, ...(row.error === undefined ? {} : { error: parseRecoveryFailure(row.error) }) } })
}
export function parseRunReport(v: unknown): AgentRunReport {
  const row = object(v)
  if (!Array.isArray(row.steps) || row.steps.length > 20 || !Array.isArray(row.remaining)) throw invalid()
  return { outcome: string(row.outcome), reason: string(row.reason), completed: integer(row.completed), failed: integer(row.failed), unconfirmed: integer(row.unconfirmed), next: string(row.next), remaining: row.remaining.map(string), steps: row.steps.map(item => { const s = object(item); return { callId: string(s.callId), tool: string(s.tool), status: string(s.status), attempts: integer(s.attempts), ...(s.error === undefined ? {} : { error: parseRecoveryFailure(s.error) }) } }), ...(row.analysis === undefined ? {} : { analysis: string(row.analysis) }) }
}
