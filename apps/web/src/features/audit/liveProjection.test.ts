import { describe, expect, it } from 'vitest'
import {
  LIVE_ACTOR,
  auditKindOfEvent,
  describeEvent,
  isLiveRecord,
  projectEventToAuditRecord,
} from './liveProjection'

const AT = '2026-09-12T09:00:00.000Z'

describe('事件到审计记录的投影', () => {
  it('按事件所属域判定审计类型', () => {
    expect(
      auditKindOfEvent({
        id: 'evt-1',
        name: 'tools/execute',
        at: AT,
        payload: { runId: 'RUN-1400', toolName: 'logs.search' },
      }),
    ).toBe('tool-call')

    expect(
      auditKindOfEvent({
        id: 'evt-2',
        name: 'approval/decided',
        at: AT,
        payload: { approvalId: 'APR-1', outcome: 'rejected' },
      }),
    ).toBe('approval')

    expect(
      auditKindOfEvent({
        id: 'evt-3',
        name: 'agent/status',
        at: AT,
        payload: { moduleId: 'coordination', status: 'idle' },
      }),
    ).toBe('decision')

    expect(
      auditKindOfEvent({
        id: 'evt-4',
        name: 'incident/updated',
        at: AT,
        payload: { incidentId: 'INC-2100' },
      }),
    ).toBe('event')
  })

  it('摘要用职责模块的中文名，不把标识暴露给用户', () => {
    const summary = describeEvent({
      id: 'evt-1',
      name: 'agent/status',
      at: AT,
      payload: { moduleId: 'incident-command', status: 'running' },
    })
    expect(summary).toContain('事故指挥')
    expect(summary).toContain('执行中')
    expect(summary).not.toContain('incident-command')
  })

  it('投影出来的记录标明来源是事件流，标识带 live 前缀', () => {
    const record = projectEventToAuditRecord({
      id: 'evt-9',
      name: 'incident/updated',
      at: AT,
      payload: { incidentId: 'INC-2100' },
    })
    expect(record.id).toBe('live-evt-9')
    expect(record.actor).toBe(LIVE_ACTOR)
    expect(record.traceId).toBe('live-evt-9')
    expect(record.at).toBe(AT)
    expect(isLiveRecord(record)).toBe(true)
  })

  it('没有单独分支的事件也有可读摘要，不会漏出空白', () => {
    const record = projectEventToAuditRecord({
      id: 'evt-10',
      name: 'session/event',
      at: AT,
      payload: { summary: '会话事件' },
    })
    expect(record.summary.trim().length).toBeGreaterThan(0)
    expect(record.kind).toBe('event')
  })

  it('详情保留原始负载，便于核对', () => {
    const record = projectEventToAuditRecord({
      id: 'evt-11',
      name: 'incident/updated',
      at: AT,
      payload: { incidentId: 'INC-2100', status: 'mitigating' },
    })
    expect(JSON.parse(record.detail)).toEqual({ incidentId: 'INC-2100', status: 'mitigating' })
  })
})
