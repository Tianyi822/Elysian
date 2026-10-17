import { describe, expect, it } from 'vitest'
import { parseRunPlan } from './agentPlanParse'
import { parseChatTimeline } from './agentChatTimelineParse'
const plan = { revision: 1, updatedAt: '2026-10-17T00:00:00Z', steps: [
  { id: 'step.1:a-b_c', title: '检查配置', status: 'in_progress' }, { id: 'next', title: '验证结果', status: 'pending' },
] }
describe('任务计划响应', () => {
  it('严格解析并经时间线透传，旧记录不补零或空计划', () => {
    expect(parseRunPlan(plan)).toEqual(plan)
    const timeline = { runId: 'r', status: 'running', done: false, entries: [] }
    expect(parseChatTimeline({ ...timeline, plan }, 'r').plan).toEqual(plan)
    expect(parseChatTimeline(timeline, 'r')).not.toHaveProperty('plan')
  })
  it.each([null, {}, [], { ...plan, revision: 0 }, { ...plan, revision: 1.5 }, { ...plan, steps: [] },
    { ...plan, steps: [plan.steps[0], plan.steps[0]] }, { ...plan, steps: Array(21).fill(plan.steps[0]) },
    ...['failed', '', null].map(status => ({ ...plan, steps: [{ ...plan.steps[0], status }] })),
    ...[' ', '字'.repeat(201)].map(title => ({ ...plan, steps: [{ ...plan.steps[0], title }] })),
    { ...plan, steps: plan.steps.map(step => ({ ...step, status: 'in_progress' })) },
  ])('拒绝畸形计划 %j', value => expect(() => parseRunPlan(value)).toThrow('任务计划响应格式无效'))
})
