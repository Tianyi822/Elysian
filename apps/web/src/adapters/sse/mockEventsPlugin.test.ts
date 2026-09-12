import { describe, expect, it } from 'vitest'
import { createMockDataset } from '../mock/dataset'
import { buildEventPlan, eventIdAt, sequenceFromLastEventId } from './mockEventsPlugin'

describe('mock 事件流端点的纯逻辑', () => {
  it('事件序列引用数据集里真实存在的标识，界面拿到的事件对得上页面', () => {
    const plan = buildEventPlan()
    expect(plan.length).toBeGreaterThan(0)

    const dataset = createMockDataset()
    const approvalIds = new Set(dataset.approvals.map((approval) => approval.id))
    const incidentIds = new Set(dataset.incidents.map((incident) => incident.id))
    const moduleIds = new Set(dataset.runs.map((run) => run.moduleId))

    for (const planned of plan) {
      if (planned.name === 'approval/asked') {
        const payload = planned.payload as { approvalId: string }
        expect(approvalIds.has(payload.approvalId)).toBe(true)
      }
      if (planned.name === 'incident/updated') {
        const payload = planned.payload as { incidentId: string }
        expect(incidentIds.has(payload.incidentId)).toBe(true)
      }
      if (planned.name === 'agent/status') {
        const payload = planned.payload as { moduleId: string }
        expect(moduleIds.has(payload.moduleId)).toBe(true)
      }
    }
  })

  it('只使用可以单向下行的 emit 型事件', () => {
    for (const planned of buildEventPlan()) {
      expect(['agent/status', 'approval/asked', 'incident/updated']).toContain(planned.name)
    }
  })

  it('事件标识单调递增且可解析回序号', () => {
    expect(eventIdAt(1)).toBe('evt-1')
    expect(eventIdAt(42)).toBe('evt-42')
    expect(sequenceFromLastEventId('evt-42')).toBe(42)
  })

  it('缺失或无法识别的续传标识从零开始，不会误判为已投递', () => {
    expect(sequenceFromLastEventId(undefined)).toBe(0)
    expect(sequenceFromLastEventId(null)).toBe(0)
    expect(sequenceFromLastEventId('')).toBe(0)
    expect(sequenceFromLastEventId('别的格式')).toBe(0)
    expect(sequenceFromLastEventId('evt-abc')).toBe(0)
  })

  it('续传从最后一条之后继续，下一帧标识正好是它的后继', () => {
    const lastSeen = sequenceFromLastEventId('evt-7')
    // 服务端把 sequence 从 7 继续，于是下一帧 id 是 evt-8，已投递的 evt-1..evt-7 不会重发。
    expect(eventIdAt(lastSeen + 1)).toBe('evt-8')
  })
})
