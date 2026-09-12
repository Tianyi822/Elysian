import { RISK_LEVELS } from '@elysian/contracts'
import type { Skill } from '@elysian/contracts'

/** 技能目录的筛选条件与地址之间的转换。 */

export const SKILL_STATES = ['enabled', 'disabled'] as const
export type SkillState = (typeof SKILL_STATES)[number]

export const SKILL_STATE_LABELS: Record<SkillState, string> = {
  enabled: '已启用',
  disabled: '已停用',
}

export type SkillQuery = {
  risks: readonly string[]
  states: readonly string[]
  capability?: string
}

function splitParam(value: string | null): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .sort()
}

export function parseSkillQuery(params: URLSearchParams): SkillQuery {
  const capability = params.get('capability')?.trim()
  return {
    risks: splitParam(params.get('risk')).filter((risk) =>
      (RISK_LEVELS as readonly string[]).includes(risk),
    ),
    states: splitParam(params.get('state')).filter((state) =>
      (SKILL_STATES as readonly string[]).includes(state),
    ),
    ...(capability ? { capability } : {}),
  }
}

export function toSkillSearchParams(query: SkillQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.risks.length > 0) params.set('risk', [...query.risks].sort().join(','))
  if (query.states.length > 0) params.set('state', [...query.states].sort().join(','))
  if (query.capability) params.set('capability', query.capability)
  return params
}

export function matchesSkillQuery(skill: Skill, query: SkillQuery): boolean {
  if (query.risks.length > 0 && !query.risks.includes(skill.riskLevel)) return false
  if (query.states.length > 0) {
    const state: SkillState = skill.enabled ? 'enabled' : 'disabled'
    if (!query.states.includes(state)) return false
  }
  if (query.capability && !skill.capabilities.includes(query.capability)) return false
  return true
}

export function hasActiveSkillFilters(query: SkillQuery): boolean {
  return query.risks.length > 0 || query.states.length > 0 || query.capability !== undefined
}

export function toggleValue(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}
