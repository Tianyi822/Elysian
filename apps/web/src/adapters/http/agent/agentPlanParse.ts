import type { AgentRunPlan } from '@elysian/contracts'

export function parseRunPlan(value: unknown): AgentRunPlan {
  const invalid = () => new Error('Agent 任务计划响应格式无效')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const row = value as Record<string, unknown>
  if (typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
      typeof row.updatedAt !== 'string' || !row.updatedAt || !Array.isArray(row.steps) || row.steps.length < 1 || row.steps.length > 20) throw invalid()
  const ids = new Set<string>()
  let active = 0
  const steps = row.steps.map((value): AgentRunPlan['steps'][number] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
    const step = value as Record<string, unknown>
    if (typeof step.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(step.id) || ids.has(step.id) ||
        typeof step.title !== 'string' || !step.title.trim() || Array.from(step.title).length > 200 ||
        (step.status !== 'pending' && step.status !== 'in_progress' && step.status !== 'completed')) throw invalid()
    ids.add(step.id)
    if (step.status === 'in_progress') active++
    return { id: step.id, title: step.title, status: step.status }
  })
  if (active > 1) throw invalid()
  return { revision: row.revision, updatedAt: row.updatedAt, steps }
}
