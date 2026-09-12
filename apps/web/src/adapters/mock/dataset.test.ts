import {
  APPROVAL_STATUSES,
  AUDIT_KINDS,
  INCIDENT_STATUSES,
  SEVERITIES,
} from '@elysian/contracts'
import { describe, expect, it } from 'vitest'
import { DATASET_BASE_TIME, createMockDataset, toIncidentListRows } from './dataset'
import { addMinutes, createRandom, intBetween, pick, pickWeighted } from './seed'

describe('确定性 mock 数据集', () => {
  it('两次构建结果完全一致', () => {
    expect(createMockDataset()).toEqual(createMockDataset())
  })

  it('基准时间是固定常量，不依赖当前时钟', () => {
    expect(DATASET_BASE_TIME).toBe('2026-09-12T08:00:00.000Z')
  })

  it('事故覆盖四档严重等级与全部事故状态', () => {
    const dataset = createMockDataset()
    const severities = [...new Set(dataset.incidents.map((incident) => incident.severity))].sort()
    const statuses = [...new Set(dataset.incidents.map((incident) => incident.status))].sort()
    expect(severities).toEqual([...SEVERITIES].sort())
    expect(statuses).toEqual([...INCIDENT_STATUSES].sort())
  })

  it('职责模块状态覆盖 13 个模块，其中 5 个有活跃运行', () => {
    const dataset = createMockDataset()
    expect(dataset.moduleStatuses).toHaveLength(13)
    expect(dataset.moduleStatuses.filter((module) => module.status === 'running')).toHaveLength(5)
    expect(dataset.moduleStatuses.filter((module) => module.activeRunId)).toHaveLength(5)

    // 标为执行中的模块，必须真的有一次进行中或等待审批的运行，
    // 不能因为「有过一次已成功的运行」就显示成还在干活。
    for (const module of dataset.moduleStatuses.filter((item) => item.status === 'running')) {
      const active = dataset.runs.filter(
        (run) =>
          run.moduleId === module.moduleId &&
          (run.status === 'running' || run.status === 'waiting-approval'),
      )
      expect(active.length, `${module.moduleId} 标为执行中却没有活跃运行`).toBeGreaterThan(0)
      expect(module.activeRunId).toBe(active[0]?.id)
    }
  })

  it('审批覆盖四种队列状态', () => {
    const statuses = [...new Set(createMockDataset().approvals.map((item) => item.status))].sort()
    expect(statuses).toEqual([...APPROVAL_STATUSES].sort())
  })

  it('没有把任何动作呈现为已真实执行', () => {
    const dataset = createMockDataset()
    for (const incident of dataset.incidents) {
      for (const action of incident.actions) {
        expect(action.execution).toBe('awaiting-integration')
      }
      for (const result of incident.executionResults) {
        expect(result.status).toBe('awaiting-integration')
      }
    }
  })

  it('每个事故都有时间线、指标、证据与建议动作', () => {
    for (const incident of createMockDataset().incidents) {
      expect(incident.timeline.length).toBeGreaterThan(1)
      expect(incident.metrics.length).toBeGreaterThan(0)
      expect(incident.evidence.length).toBeGreaterThan(0)
      expect(incident.actions.length).toBeGreaterThan(0)
    }
  })

  it('判断引用的证据标识都能对上', () => {
    for (const incident of createMockDataset().incidents) {
      const evidenceIds = new Set(incident.evidence.map((item) => item.id))
      for (const finding of incident.findings) {
        expect(finding.evidenceIds.length).toBeGreaterThan(0)
        for (const evidenceId of finding.evidenceIds) {
          expect(evidenceIds.has(evidenceId), `${finding.id} 引用了不存在的证据`).toBe(true)
        }
      }
    }
  })

  it('运行都有轮次、步骤与模型请求', () => {
    const runs = createMockDataset().runs
    expect(runs.length).toBeGreaterThan(0)
    for (const run of runs) {
      expect(run.turns.length).toBeGreaterThan(0)
      for (const turn of run.turns) {
        expect(turn.steps.length).toBeGreaterThan(0)
        for (const step of turn.steps) {
          expect(step.modelRequests.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it('等待审批的运行带可读等待原因', () => {
    const waiting = createMockDataset().runs.filter((run) => run.status === 'waiting-approval')
    expect(waiting.length).toBeGreaterThan(0)
    for (const run of waiting) {
      expect(run.waitingReason?.trim()).toBeTruthy()
    }
  })

  it('高风险动作都有对应的审批请求', () => {
    const dataset = createMockDataset()
    const approvalIds = new Set(dataset.approvals.map((item) => item.id))
    for (const incident of dataset.incidents) {
      for (const action of incident.actions) {
        if (action.riskLevel !== 'high' && action.riskLevel !== 'critical') continue
        expect(action.approvalId, `${action.id} 缺少审批标识`).toBeTruthy()
        expect(approvalIds.has(action.approvalId ?? '')).toBe(true)
      }
    }
  })

  it('审计记录按时间倒序，且五类审计都有', () => {
    const audit = createMockDataset().audit
    expect(audit.length).toBeGreaterThan(0)
    for (let index = 1; index < audit.length; index += 1) {
      const previous = audit[index - 1]
      const current = audit[index]
      expect(previous && current && previous.at >= current.at).toBe(true)
    }
    expect(new Set(audit.map((record) => record.kind))).toEqual(new Set(AUDIT_KINDS))
  })

  it('列表行包含事故、告警与待处理任务三类', () => {
    const rows = toIncidentListRows(createMockDataset())
    expect(new Set(rows.map((row) => row.kind))).toEqual(
      new Set(['incident', 'alert', 'pending-task']),
    )
  })
})

describe('确定性伪随机与时间工具', () => {
  it('同一 seed 产出同一序列', () => {
    const first = createRandom(42)
    const second = createRandom(42)
    expect([first(), first(), first()]).toEqual([second(), second(), second()])
  })

  it('pick 只从给定集合里取，遇到空集合立即报错', () => {
    const rnd = createRandom(7)
    for (let index = 0; index < 50; index += 1) {
      expect(['a', 'b', 'c']).toContain(pick(rnd, ['a', 'b', 'c']))
    }
    expect(() => pick(rnd, [])).toThrow()
  })

  it('pickWeighted 只返回给定取值', () => {
    const rnd = createRandom(3)
    for (let index = 0; index < 50; index += 1) {
      expect(['x', 'y']).toContain(
        pickWeighted(rnd, [
          ['x', 1],
          ['y', 3],
        ] as const),
      )
    }
  })

  it('时间工具按分钟加减，可跨小时与跨天', () => {
    expect(addMinutes('2026-09-12T08:00:00.000Z', 30)).toBe('2026-09-12T08:30:00.000Z')
    expect(addMinutes('2026-09-12T08:00:00.000Z', -60)).toBe('2026-09-12T07:00:00.000Z')
  })

  it('intBetween 落在闭区间内', () => {
    const rnd = createRandom(11)
    for (let index = 0; index < 100; index += 1) {
      const value = intBetween(rnd, 2, 5)
      expect(value).toBeGreaterThanOrEqual(2)
      expect(value).toBeLessThanOrEqual(5)
    }
  })
})
