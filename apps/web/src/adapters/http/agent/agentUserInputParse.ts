import type { AgentUserInputAnswer, AgentUserInputRequest } from '@elysian/contracts'
const invalid = () => new Error('用户选择响应格式无效')
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
const string = (value: unknown): string => { if (typeof value !== 'string') throw invalid(); return value }
const optional = (value: unknown) => value === undefined ? undefined : string(value)

export function parseUserInput(value: unknown, runId: string): AgentUserInputRequest {
  const row = object(value)
  if (row.runId !== runId || !['pending', 'answered', 'cancelled'].includes(string(row.status)) || !Array.isArray(row.questions) || row.questions.length < 1 || row.questions.length > 3) throw invalid()
  const ids = new Set<string>()
  const questions = row.questions.map(value => {
    const q = object(value)
    const id = string(q.id)
    if (!id || ids.has(id) || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 3) throw invalid()
    ids.add(id)
    const options = q.options.map(value => { const o = object(value); return { id: string(o.id), label: string(o.label), description: string(o.description) } })
    if (new Set(options.map(o => o.id)).size !== options.length || options.some(o => !o.id || !o.label.trim() || !o.description.trim())) throw invalid()
    const recommendedOptionId = optional(q.recommendedOptionId)
    if (recommendedOptionId && !options.some(o => o.id === recommendedOptionId)) throw invalid()
    return { id, header: string(q.header), question: string(q.question), options, recommendedOptionId }
  })
  let answers: Record<string, AgentUserInputAnswer> | undefined
  if (row.answers !== undefined) {
    answers = Object.create(null) as Record<string, AgentUserInputAnswer>
    for (const [key, value] of Object.entries(object(row.answers))) {
      const answer = object(value)
      const question = questions.find(q => q.id === key)
      if (!question || (answer.optionId !== undefined) === (answer.text !== undefined)) throw invalid()
      if (answer.optionId !== undefined) {
        const optionId = string(answer.optionId)
        if (!question.options.some(o => o.id === optionId)) throw invalid()
        answers[key] = { optionId }
      } else {
        const text = string(answer.text)
        if (!text.trim()) throw invalid()
        answers[key] = { text }
      }
    }
  }
  if (row.status === 'answered' && (!answers || Object.keys(answers).length !== questions.length || !row.answerRequestId)) throw invalid()
  return { id: string(row.id), runId, modelRequestId: string(row.modelRequestId), modelCallId: string(row.modelCallId), callId: string(row.callId), status: row.status as AgentUserInputRequest['status'], questions, answers, answerRequestId: optional(row.answerRequestId), createdAt: string(row.createdAt), endedAt: optional(row.endedAt) }
}
