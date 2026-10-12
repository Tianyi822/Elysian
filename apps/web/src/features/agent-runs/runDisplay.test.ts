import { describe, expect, it } from 'vitest'
import type { RuntimeRun } from '@elysian/contracts'
import {
  RUN_PHASE_LABELS,
  capabilityRows,
  formatActiveDuration,
  formatBytes,
  interruptedReasonText,
  isMemoryPhase,
  runCancelRequested,
  runIsTerminal,
  runKindOf,
  usageUnknown,
} from './runDisplay'

/** 展示辅助的纯函数断言：标签表、字节/时长格式化、终态与取消请求判定。 */

const BASE_RUN = {
  id: 'run-x', taskId: 'task-x', status: 'running', createdAt: 't',
  limits: {} as RuntimeRun['limits'], usage: { calls: 0, resultBytes: 0 }, lastSeq: '0',
} as RuntimeRun

describe('runDisplay', () => {
  it('phase 八相标签齐全；checkpoint 与 final-memory 统一为「整理中」', () => {
    expect(Object.keys(RUN_PHASE_LABELS).sort()).toEqual([
      'checkpoint', 'completed', 'final-memory', 'inference', 'queued',
      'waiting-approval', 'waiting-resource', 'workflow-output',
    ])
    expect(RUN_PHASE_LABELS.checkpoint).toBe('整理中')
    expect(RUN_PHASE_LABELS['final-memory']).toBe('整理中')
    expect(isMemoryPhase('checkpoint')).toBe(true)
    expect(isMemoryPhase('final-memory')).toBe(true)
    expect(isMemoryPhase('inference')).toBe(false)
  })

  it('kind 与驱动：按 task.kind 优先，无 task 时按 workflowId/sessionId 推断', () => {
    expect(runKindOf({ ...BASE_RUN, task: { id: 't', requestId: 'r', kind: 'tool-batch', driverVersion: 'v1', createdAt: 't', steps: [] } })).toBe('tool-batch')
    expect(runKindOf({ ...BASE_RUN, workflowId: 'wf' })).toBe('workflow')
    expect(runKindOf({ ...BASE_RUN, sessionId: 's', driverVersion: 'v2' })).toBe('agent')
    expect(runKindOf(BASE_RUN)).toBe('tool-batch')
  })

  it('终态与「已请求取消」判定严格分栏', () => {
    expect(runIsTerminal({ ...BASE_RUN, status: 'recovery-required' })).toBe(false)
    expect(runIsTerminal({ ...BASE_RUN, status: 'interrupted' })).toBe(true)
    expect(runCancelRequested({ ...BASE_RUN, cancelRequestedAt: 't1' })).toBe(true)
    expect(runCancelRequested({ ...BASE_RUN, status: 'cancelled', cancelRequestedAt: 't1' })).toBe(false)
  })

  it('interrupted 原因文案：endReason + 错误消息', () => {
    expect(interruptedReasonText({ ...BASE_RUN, status: 'interrupted', endReason: 'worker-lost', error: { code: 'worker-lost', message: 'Worker 失联' } }))
      .toBe('worker-lost：Worker 失联')
    expect(interruptedReasonText({ ...BASE_RUN, status: 'interrupted' })).toBe('unknown：运行被中断，原因未随记录下发')
  })

  it('字节与时长格式化；用量未知不补零', () => {
    expect(formatBytes(96)).toBe('96 B')
    expect(formatBytes(2048)).toBe('2.0 KiB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MiB')
    expect(formatActiveDuration(undefined)).toBe('—')
    expect(formatActiveDuration(65_000)).toBe('1 分 5 秒')
    expect(formatActiveDuration(45_000)).toBe('45 秒')
    expect(usageUnknown(undefined)).toBe('未知')
    expect(usageUnknown(104)).toBe('104')
  })

  it('能力位行按固定次序展开 12 项', () => {
    const rows = capabilityRows({
      available: true, worker: 'ready', storage: 'ready', tools: [], queueDepth: 0,
      limits: BASE_RUN.limits,
      batch: { available: true }, agent: { available: false, reason: '未配置' }, skills: { available: true },
      mcp: { available: true }, containerExecution: { available: true }, approvals: { available: true },
      workflow: { available: true }, wiki: { available: true }, embedding: { available: true },
      workflowV2: { available: true }, resourceLocks: { available: true }, executionRuntimes: { available: true },
    })
    expect(rows).toHaveLength(12)
    expect(rows[1]).toEqual({ key: 'agent', label: 'Agent 会话', available: false, reason: '未配置' })
    expect(rows.filter((row) => !row.available)).toHaveLength(1)
  })
})
