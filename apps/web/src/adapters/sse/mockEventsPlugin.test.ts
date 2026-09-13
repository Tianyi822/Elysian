import { describe, expect, it } from 'vitest'
import { createMockDataset } from '../mock/dataset'
import {
  buildEventPlan,
  initialResourceWalk,
  eventIdAt,
  maybeIncidentCreated,
  nextResourceSample,
  sequenceFromLastEventId,
} from './mockEventsPlugin'

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

describe('实时采样与新事故注入', () => {
  it('资源采样随机游走 200 拍都保持在区间内', () => {
    let walk = initialResourceWalk()
    for (let index = 0; index < 200; index += 1) {
      walk = nextResourceSample(walk)
      expect(walk.cpu).toBeGreaterThanOrEqual(20)
      expect(walk.cpu).toBeLessThanOrEqual(90)
      expect(walk.memory).toBeGreaterThanOrEqual(45)
      expect(walk.memory).toBeLessThanOrEqual(92)
      expect(walk.networkIo).toBeGreaterThanOrEqual(60)
      expect(walk.networkIo).toBeLessThanOrEqual(950)
      expect(walk.diskIo).toBeGreaterThanOrEqual(40)
      expect(walk.diskIo).toBeLessThanOrEqual(520)
    }
  })

  it('每 8 拍产生一次新事故，序号递增，其余拍不产生', () => {
    expect(maybeIncidentCreated(1, 0)).toBeUndefined()
    expect(maybeIncidentCreated(7, 0)).toBeUndefined()

    const first = maybeIncidentCreated(8, 0)
    expect(first?.name).toBe('incident/created')
    expect((first?.payload as { incidentId: string }).incidentId).toBe('INC-LIVE-1')

    expect(maybeIncidentCreated(9, 1)).toBeUndefined()
    const second = maybeIncidentCreated(16, 1)
    expect((second?.payload as { incidentId: string }).incidentId).toBe('INC-LIVE-2')
  })

  it('新事故的严重等级都合法', () => {
    for (let tick = 8; tick <= 80; tick += 8) {
      const live = maybeIncidentCreated(tick, 0)
      const severity = (live?.payload as { severity: string }).severity
      expect(['sev1', 'sev2', 'sev3', 'sev4']).toContain(severity)
    }
  })
})
