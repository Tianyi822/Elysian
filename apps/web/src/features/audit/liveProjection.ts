import { AUDIT_KIND_LABELS, responsibilityModuleName, AGENT_STATUS_LABELS } from '@elysian/contracts'
import type { AuditKind, AuditRecord, ElysianEvent } from '@elysian/contracts'

/**
 * 把事件流里的事件投影成一条审计记录，供审计日志实时增长。
 *
 * 这是展示用的投影：真实实现里审计记录由服务端落库，事件只用来触发界面刷新。
 * 因此投影出来的记录会带上「实时」标记，来源也写明是事件流，不与数据集里的记录混为一谈。
 */

const KIND_BY_DOMAIN: Record<string, AuditKind> = {
  agent: 'decision',
  tools: 'tool-call',
  approval: 'approval',
  skills: 'event',
  session: 'event',
  incident: 'event',
}

export const LIVE_ACTOR = '事件流'

export function auditKindOfEvent(event: ElysianEvent): AuditKind {
  const domain = event.name.split('/')[0] ?? ''
  return KIND_BY_DOMAIN[domain] ?? 'event'
}

export function describeEvent(event: ElysianEvent): string {
  switch (event.name) {
    case 'agent/status':
      return `职责模块「${responsibilityModuleName(event.payload.moduleId)}」状态变为 ${AGENT_STATUS_LABELS[event.payload.status]}`
    case 'agent/created':
      return `职责模块「${responsibilityModuleName(event.payload.moduleId)}」开始处理运行 ${event.payload.runId}`
    case 'approval/asked':
      return `审批请求 ${event.payload.approvalId} 进入队列`
    case 'approval/decided':
      return `审批请求 ${event.payload.approvalId} 决策完成`
    case 'incident/updated':
      return `事故 ${event.payload.incidentId} 状态更新`
    case 'incident/created':
      return `事故 ${event.payload.incidentId} 创建，严重等级 ${event.payload.severity}`
    case 'skills/change':
      return `技能 ${event.payload.skillId} ${event.payload.enabled ? '已启用' : '已停用'}`
    default:
      return `收到事件 ${event.name}`
  }
}

export function projectEventToAuditRecord(event: ElysianEvent): AuditRecord {
  const kind = auditKindOfEvent(event)
  return {
    id: `live-${event.id}`,
    at: event.at,
    kind,
    actor: LIVE_ACTOR,
    subject: event.name,
    summary: `${AUDIT_KIND_LABELS[kind]}：${describeEvent(event)}`,
    detail: JSON.stringify(event.payload, null, 2),
    traceId: `live-${event.id}`,
  }
}

export function isLiveRecord(record: AuditRecord): boolean {
  return record.actor === LIVE_ACTOR
}
