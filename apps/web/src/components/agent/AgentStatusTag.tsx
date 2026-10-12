import type {
  AgentApprovalStatus,
  AgentOperationStatus,
  AgentResourceLeaseStatus,
  AgentWorkflowStatus,
  RuntimeRunStatus,
} from '@elysian/contracts'
import {
  AGENT_APPROVAL_STATUS_LABELS,
  AGENT_OPERATION_STATUS_LABELS,
  AGENT_RESOURCE_LEASE_STATUS_LABELS,
  AGENT_WORKFLOW_STATUS_LABELS,
  RUNTIME_RUN_STATUS_LABELS,
} from '@elysian/contracts'
import { StatusTag } from '../StatusTag'
import type { StatusTone } from '../StatusTag'

/*
 * Agent 域状态标签：五族状态到 StatusTag 五档 tone 的唯一映射表。
 * 文字来自契约的中文标签表，颜色由本表决定；状态一律「文字 + 颜色」双表达。
 * 「整理中」不是独立状态：Run running 且 phase 为 checkpoint/final-memory 由页面组合呈现。
 */

const RUN_STATUS_TONES: Record<RuntimeRunStatus, StatusTone> = {
  queued: 'info',
  running: 'info',
  'waiting-approval': 'warning',
  'waiting-resource': 'warning',
  'recovery-required': 'danger',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  interrupted: 'danger',
}

const APPROVAL_STATUS_TONES: Record<AgentApprovalStatus, StatusTone> = {
  pending: 'warning',
  approved: 'success',
  denied: 'danger',
  expired: 'neutral',
  consumed: 'info',
  revoked: 'neutral',
}

const WORKFLOW_STATUS_TONES: Record<AgentWorkflowStatus, StatusTone> = {
  ready: 'info',
  queued: 'info',
  running: 'info',
  'waiting-approval': 'warning',
  'waiting-resource': 'warning',
  'recovery-required': 'danger',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  interrupted: 'danger',
}

const OPERATION_STATUS_TONES: Record<AgentOperationStatus, StatusTone> = {
  planned: 'info',
  'waiting-approval': 'warning',
  'waiting-resource': 'warning',
  dispatched: 'info',
  completed: 'success',
  unknown: 'danger',
}

const RESOURCE_LEASE_STATUS_TONES: Record<AgentResourceLeaseStatus, StatusTone> = {
  waiting: 'warning',
  held: 'info',
  unknown: 'danger',
  released: 'success',
}

export function AgentRunStatusTag({ status }: { status: RuntimeRunStatus }) {
  return <StatusTag label={RUNTIME_RUN_STATUS_LABELS[status]} tone={RUN_STATUS_TONES[status]} />
}

export function AgentApprovalStatusTag({ status }: { status: AgentApprovalStatus }) {
  return <StatusTag label={AGENT_APPROVAL_STATUS_LABELS[status]} tone={APPROVAL_STATUS_TONES[status]} />
}

export function AgentWorkflowStatusTag({ status }: { status: AgentWorkflowStatus }) {
  return <StatusTag label={AGENT_WORKFLOW_STATUS_LABELS[status]} tone={WORKFLOW_STATUS_TONES[status]} />
}

export function AgentOperationStatusTag({ status }: { status: AgentOperationStatus }) {
  return <StatusTag label={AGENT_OPERATION_STATUS_LABELS[status]} tone={OPERATION_STATUS_TONES[status]} />
}

export function AgentResourceLeaseStatusTag({ status }: { status: AgentResourceLeaseStatus }) {
  return <StatusTag label={AGENT_RESOURCE_LEASE_STATUS_LABELS[status]} tone={RESOURCE_LEASE_STATUS_TONES[status]} />
}
