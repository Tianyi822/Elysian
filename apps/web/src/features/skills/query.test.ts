import { describe, expect, it } from 'vitest'
import { createMockDataset } from '../../adapters/mock/dataset'
import {
  hasActiveSkillFilters,
  matchesSkillQuery,
  parseSkillQuery,
  toSkillSearchParams,
  toggleValue,
} from './query'

const dataset = createMockDataset()
const firstSkill = dataset.skills[0]

describe('技能筛选条件与地址的互转', () => {
  it('空地址解析为空条件', () => {
    expect(parseSkillQuery(new URLSearchParams(''))).toEqual({
      risks: [],
      states: [],
    })
  })

  it('多值与未知取值都按规则处理', () => {
    const query = parseSkillQuery(
      new URLSearchParams('risk=critical,high&state=enabled,乱写&capability=k8s.pod.list'),
    )
    expect(query.risks).toEqual(['critical', 'high'])
    expect(query.states).toEqual(['enabled'])
    expect(query.capability).toBe('k8s.pod.list')
  })

  it('序列化与解析互为逆运算，空条件不写进地址', () => {
    const query = { risks: ['high'], states: ['disabled'], capability: 'logs.search' }
    expect(parseSkillQuery(toSkillSearchParams(query))).toEqual(query)
    expect(toSkillSearchParams({ risks: [], states: [] }).toString()).toBe('')
  })

  it('按风险、启用状态与能力三个维度过滤', () => {
    expect(firstSkill).toBeDefined()
    if (!firstSkill) return

    expect(matchesSkillQuery(firstSkill, { risks: [], states: [] })).toBe(true)
    expect(matchesSkillQuery(firstSkill, { risks: [firstSkill.riskLevel], states: [] })).toBe(true)
    expect(
      matchesSkillQuery(firstSkill, {
        risks: [firstSkill.riskLevel === 'low' ? 'critical' : 'low'],
        states: [],
      }),
    ).toBe(false)

    const state = firstSkill.enabled ? 'enabled' : 'disabled'
    expect(matchesSkillQuery(firstSkill, { risks: [], states: [state] })).toBe(true)
    expect(
      matchesSkillQuery(firstSkill, {
        risks: [],
        states: [firstSkill.enabled ? 'disabled' : 'enabled'],
      }),
    ).toBe(false)

    const capability = firstSkill.capabilities[0]
    expect(capability).toBeDefined()
    if (capability) {
      expect(matchesSkillQuery(firstSkill, { risks: [], states: [], capability })).toBe(true)
      expect(
        matchesSkillQuery(firstSkill, { risks: [], states: [], capability: '不存在的.能力' }),
      ).toBe(false)
    }
  })

  it('能力筛选能命中提供该能力的所有技能', () => {
    const capability = 'logs.search'
    const expected = dataset.skills.filter((skill) => skill.capabilities.includes(capability))
    expect(expected.length).toBeGreaterThan(0)
    expect(
      dataset.skills.filter((skill) => matchesSkillQuery(skill, { risks: [], states: [], capability })),
    ).toHaveLength(expected.length)
  })

  it('toggleValue 与 hasActiveSkillFilters 行为符合预期', () => {
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleValue(['a'], 'a')).toEqual([])
    expect(hasActiveSkillFilters({ risks: [], states: [] })).toBe(false)
    expect(hasActiveSkillFilters({ risks: ['low'], states: [] })).toBe(true)
    expect(hasActiveSkillFilters({ risks: [], states: [], capability: 'x' })).toBe(true)
  })
})
