import type {
  AgentApproval,
  AgentContextItem,
  AgentExecutionBarrier,
  AgentOperation,
  AgentResourceLease,
} from '@elysian/contracts'

/*
 * 审批与治理域的确定性演示数据集与状态机。语义逐条对照服务端 harness：
 * - Decide（capability_store.go:270）：同决定重复幂等；不同决定 409 decision-conflict；
 *   批准把 Run 置 queued、拒绝置 failed(approval-denied) 且记忆标 stale；
 *   队列满（测试钩子 setAgentApprovalsQueueFull）429 queue-full 且审批保持 pending。
 * - 列表读取（capability_store.go:202/211）：先做过期清扫（pending/approved 且
 *   expiresAt 已过 → expired，Run 终态 failed(approval-expired)、记忆 stale，
 *   工作流 Run 改 recovery-required），再按「pending/approved 优先、rowid 倒序、
 *   最多 200 条」返回；workflowId 过滤与 SQL 同口径。
 * - Reconcile（capability_store.go:226）：仅 unknown 可核实；同证据同决定幂等；
 *   已核实后换决定 409 decision-conflict；非 unknown 409 barrier-state-conflict；
 *   核实同时释放绑定同一 Operation 的资源租约（settleResourceLease）。
 * - ReconcileProbeLease（probe_lifecycle.go:103）：仅 source=mcp-probe 且无
 *   Run/Operation 的租约、仅 confirmed-stopped；unknown 才可核实；released 后
 *   同证据同决定幂等、否则 409 lease-state-conflict。
 * - Revoke（materials.go:120）：{revision,reason}，原因 1..2048 字节，
 *   成功返回 {revoked:true}，重复撤销幂等；撤销事实记录在案供界面回读标注。
 *
 * 时间口径：createAgentApprovalsSeed(now) 相对注入基准时间生成，绝对时间不依赖
 * 当前时钟；resetAgentApprovalsData() 缺省用真实当前时间（演示倒计时需要未来
 * 到期点），测试一律传入固定基准时间保证可复现。
 */

/** 四类可撤销能力，与服务端 capability_routes.go 的 kind 一一对应。 */
export type AgentRevocationKind = 'skill' | 'mcp' | 'execution-profile' | 'grant'

export type AgentRevocationFact = {
  kind: AgentRevocationKind
  id: string
  revision: number
  reason: string
  revokedAt: string
}

/** 决定审批时受影响 Run 的演示事实（对齐服务端 Decide/expire 的副作用）。 */
export type AgentApprovalsRunFact = {
  id: string
  taskId: string
  sessionId: string
  status: 'queued' | 'running' | 'waiting-approval' | 'waiting-resource' | 'recovery-required' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  phase?: string
  memoryStatus?: 'unchanged' | 'updated' | 'stale' | 'invalidated'
  endReason?: string
  endedAt?: string
  workflowId?: string
  scopeId?: string
  nodeId?: string
  error?: { code: string; message: string }
}

export type AgentApprovalsDataState = {
  now: string
  /** rowid 顺序（追加序），读取时再排序。 */
  approvals: AgentApproval[]
  barriers: AgentExecutionBarrier[]
  locks: AgentResourceLease[]
  operationsByRun: Record<string, readonly AgentOperation[]>
  contextItemsByRun: Record<string, readonly AgentContextItem[]>
  runs: Record<string, AgentApprovalsRunFact>
  revocations: AgentRevocationFact[]
}

/** 带错误码的领域错误：mock 与 HTTP 适配器对页面暴露同一形状。 */
export class AgentApprovalsDomainError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, code: string, status = 409) {
    super(message)
    this.name = 'AgentApprovalsDomainError'
    this.code = code
    this.status = status
  }
}

const encoder = new TextEncoder()

function addHours(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString()
}

function expiryState(approval: AgentApproval, now: string): boolean {
  const expiresAt = new Date(approval.expiresAt).getTime()
  const base = new Date(now).getTime()
  return !Number.isNaN(expiresAt) && expiresAt <= base
}

/** pending/approved 优先（0），其余靠后（1）——与服务端 SQL 同序。 */
function approvalOrderGroup(status: AgentApproval['status']): number {
  return status === 'pending' || status === 'approved' ? 0 : 1
}

export function createAgentApprovalsSeed(now: string): AgentApprovalsDataState {
  const argumentsJson = '{"value":9007199254740993,"note":"演示审批参数，原文保留"}'
  const capability: AgentOperation['capability'] = {
    name: 'mcp_demo_status_write',
    description: '更新演示 MCP 服务的状态键',
    parameters: { type: 'object', properties: { value: { type: 'integer' }, note: { type: 'string' } }, required: ['value'], additionalProperties: false },
    source: 'mcp-tool',
    ref: { id: 'mcp-11111111111111111111111111111111', revision: 2, digest: 'demo-server-digest' },
    originalName: 'write_status',
    catalogDigest: 'demo-catalog-digest',
    readOnly: false,
  }
  const pendingOperation: AgentOperation = {
    scopeId: 'scope-root',
    nodeId: 'node-write',
    workflowId: 'wf-demo-1',
    workflowStepId: 'step-write',
    workflowAttempt: 1,
    id: 'op-pending-write',
    runId: 'run-pending',
    taskId: 'task-demo-1',
    modelRequestId: 'model-request-pending',
    callIndex: 0,
    modelCallId: 'proposal-pending',
    argumentsJson,
    capability,
    snapshotDigest: 'demo-snapshot-digest',
    workspaceRevision: 3,
    execution: {
      profile: {
        id: 'exec-python-demo', revision: 1, enabled: true, name: 'Python 演示执行配置', image: 'python:3.12-slim',
        runtime: 'python', command: ['python', 'script.py'], timeoutSeconds: 300, cpuMillis: 1000, memoryBytes: 536870912, pids: 128,
        createdAt: addHours(now, -72),
      },
      grant: {
        id: 'grant-demo-workspace', revision: 1, enabled: true, name: '演示工作区授权',
        directories: [{ path: '/workspace', access: 'rw' }],
        network: [{ scheme: 'https', host: 'registry.example', port: 443 }],
        privateCidrs: [],
        createdAt: addHours(now, -72),
      },
      scriptDigest: 'demo-script-digest',
    },
    policy: 'approval-required',
    status: 'waiting-approval',
    approvalId: 'ap-pending-write',
    callId: 'call-pending-write',
    createdAt: addHours(now, -1),
  }
  const consumedOperation: AgentOperation = {
    id: 'op-consumed-read',
    runId: 'run-consumed',
    taskId: 'task-demo-1',
    modelRequestId: 'model-request-consumed',
    callIndex: 0,
    modelCallId: 'proposal-consumed',
    argumentsJson: '{}',
    capability: { ...capability, name: 'docker_containers_list', description: '列出容器', source: 'builtin', readOnly: true, ref: { id: 'builtin', revision: 1 } },
    snapshotDigest: 'demo-snapshot-digest',
    workspaceRevision: 3,
    policy: 'trusted-read-only',
    status: 'completed',
    approvalId: 'ap-consumed-read',
    callId: 'call-consumed-read',
    createdAt: addHours(now, -26),
    dispatchedAt: addHours(now, -25),
    endedAt: addHours(now, -25),
  }
  const deniedOperation: AgentOperation = {
    id: 'op-denied-write',
    runId: 'run-denied',
    taskId: 'task-demo-1',
    modelRequestId: 'model-request-denied',
    callIndex: 0,
    modelCallId: 'proposal-denied',
    argumentsJson: '{"value":1}',
    capability: { ...capability, name: 'mcp_demo_tag_write', originalName: 'write_tag', description: '写入演示标签（已拒绝的示例）' },
    snapshotDigest: 'demo-snapshot-digest',
    workspaceRevision: 2,
    policy: 'approval-required',
    status: 'waiting-approval',
    approvalId: 'ap-denied-write',
    callId: 'call-denied-write',
    createdAt: addHours(now, -48),
  }
  const unknownOperation: AgentOperation = {
    scopeId: 'scope-agent',
    nodeId: 'node-script',
    workflowId: 'wf-demo-2',
    workflowStepId: 'step-script',
    workflowAttempt: 2,
    id: 'op-unknown-script',
    runId: 'run-unknown',
    taskId: 'task-demo-2',
    modelRequestId: 'model-request-unknown',
    callIndex: 1,
    modelCallId: 'proposal-unknown',
    argumentsJson: '{"script":"check.sh"}',
    capability: { ...capability, name: 'script_run', description: '执行容器脚本', source: 'script', ref: { id: 'script-demo', revision: 1 } },
    snapshotDigest: 'demo-snapshot-digest-2',
    workspaceRevision: 1,
    execution: {
      profile: pendingOperation.execution?.profile as NonNullable<AgentOperation['execution']>['profile'],
      scriptDigest: 'demo-script-digest',
    },
    policy: 'approval-required',
    status: 'unknown',
    callId: 'call-unknown-script',
    createdAt: addHours(now, -4),
    dispatchedAt: addHours(now, -3),
    endedAt: addHours(now, -3),
    error: { code: 'outcome-unknown', message: '面板重启时操作已派发，结果未确认' },
  }
  const dispatchedOperation: AgentOperation = {
    id: 'op-dispatched-script',
    runId: 'run-dispatched',
    taskId: 'task-demo-2',
    modelRequestId: 'model-request-dispatched',
    callIndex: 0,
    modelCallId: 'proposal-dispatched',
    argumentsJson: '{"script":"sync.sh"}',
    capability: { ...capability, name: 'script_run', description: '执行容器脚本', source: 'script', ref: { id: 'script-demo', revision: 1 } },
    snapshotDigest: 'demo-snapshot-digest-2',
    workspaceRevision: 1,
    policy: 'approval-required',
    status: 'dispatched',
    approvalId: 'ap-dispatched-script',
    callId: 'call-dispatched-script',
    createdAt: addHours(now, -2),
    dispatchedAt: addHours(now, -2),
  }
  const gate: AgentApproval = {
    kind: 'workflow-gate',
    scopeId: 'scope-root',
    nodeId: 'node-confirm',
    workflowId: 'wf-demo-1',
    workflowStepId: 'confirm',
    workflowAttempt: 1,
    contentDigest: 'demo-gate-digest',
    instruction: '确认发布演示站点的新版本。',
    inputJson: '{"version":"1.2.0"}',
    id: 'ap-gate-confirm',
    runId: 'run-gate',
    status: 'pending',
    createdAt: addHours(now, -1),
    expiresAt: addHours(now, 23),
  }
  const approvals: AgentApproval[] = [
    {
      scopeId: 'scope-root',
      nodeId: 'node-write',
      workflowId: 'wf-demo-1',
      workflowStepId: 'step-write',
      workflowAttempt: 1,
      id: 'ap-pending-write',
      runId: 'run-pending',
      operationId: 'op-pending-write',
      status: 'pending',
      createdAt: addHours(now, -1),
      expiresAt: addHours(now, 23),
      operation: pendingOperation,
    },
    gate,
    {
      id: 'ap-consumed-read',
      runId: 'run-consumed',
      operationId: 'op-consumed-read',
      status: 'consumed',
      createdAt: addHours(now, -26),
      expiresAt: addHours(now, 2),
      decidedAt: addHours(now, -25),
      decision: 'approved',
      operation: consumedOperation,
    },
    {
      id: 'ap-expired-write',
      runId: 'run-expired',
      operationId: 'op-expired-write',
      status: 'expired',
      createdAt: addHours(now, -50),
      expiresAt: addHours(now, -26),
      decidedAt: addHours(now, -26),
      operation: {
        ...deniedOperation,
        id: 'op-expired-write', runId: 'run-expired', approvalId: 'ap-expired-write', callId: 'call-expired-write',
        createdAt: addHours(now, -50),
        capability: { ...capability, name: 'mcp_demo_legacy_write', originalName: 'write_legacy', description: '写入旧版本状态（已过期的示例）' },
      },
    },
    {
      id: 'ap-denied-write',
      runId: 'run-denied',
      operationId: 'op-denied-write',
      status: 'denied',
      createdAt: addHours(now, -48),
      expiresAt: addHours(now, -24),
      decidedAt: addHours(now, -47),
      decision: 'denied',
      operation: deniedOperation,
    },
  ]
  const runs: Record<string, AgentApprovalsRunFact> = {
    'run-pending': { id: 'run-pending', taskId: 'task-demo-1', sessionId: 'sess-demo', status: 'waiting-approval', phase: 'waiting-approval', workflowId: 'wf-demo-1', scopeId: 'scope-root', nodeId: 'node-write' },
    'run-gate': { id: 'run-gate', taskId: 'task-demo-1', sessionId: 'sess-demo', status: 'waiting-approval', phase: 'waiting-approval', workflowId: 'wf-demo-1', scopeId: 'scope-root', nodeId: 'node-confirm' },
    'run-consumed': { id: 'run-consumed', taskId: 'task-demo-1', sessionId: 'sess-demo', status: 'succeeded', memoryStatus: 'updated' },
    'run-expired': { id: 'run-expired', taskId: 'task-demo-1', sessionId: 'sess-demo', status: 'failed', memoryStatus: 'stale', endReason: 'approval-expired', endedAt: addHours(now, -26), error: { code: 'approval-expired', message: '审批已过期，运行已结束' } },
    'run-denied': { id: 'run-denied', taskId: 'task-demo-1', sessionId: 'sess-demo', status: 'failed', memoryStatus: 'stale', endReason: 'approval-denied', endedAt: addHours(now, -47), error: { code: 'approval-denied', message: '操作者拒绝本次操作，运行已结束' } },
    'run-unknown': { id: 'run-unknown', taskId: 'task-demo-2', sessionId: 'sess-demo-2', status: 'recovery-required', workflowId: 'wf-demo-2', scopeId: 'scope-agent', nodeId: 'node-script' },
    'run-dispatched': { id: 'run-dispatched', taskId: 'task-demo-2', sessionId: 'sess-demo-2', status: 'running', phase: 'inference', workflowId: 'wf-demo-2' },
  }
  const barriers: AgentExecutionBarrier[] = [
    {
      scopeId: 'scope-agent', nodeId: 'node-script', workflowId: 'wf-demo-2',
      id: 'bar-unknown-script', runId: 'run-unknown', operationId: 'op-unknown-script',
      status: 'unknown', createdAt: addHours(now, -3),
    },
    {
      workflowId: 'wf-demo-2',
      id: 'bar-dispatched-script', runId: 'run-dispatched', operationId: 'op-dispatched-script',
      status: 'dispatched', createdAt: addHours(now, -2),
    },
    {
      scopeId: 'scope-agent', nodeId: 'node-script', workflowId: 'wf-demo-2',
      id: 'bar-reconciled-script', runId: 'run-old', operationId: 'op-old-script',
      status: 'reconciled', createdAt: addHours(now, -30),
      evidence: 'docker ps 显示容器已退出（exit 0），日志无未完成写入。',
      decision: 'confirmed-stopped',
      reconciledAt: addHours(now, -28),
    },
  ]
  const locks: AgentResourceLease[] = [
    {
      id: 'lock-probe-unknown', source: 'mcp-probe', serverId: 'mcp-11111111111111111111111111111111', serverRevision: 2,
      containerId: 'demo-container-1', scopeId: 'probe-demo-1', state: 'unknown',
      claims: [{ kind: 'global', authority: 'external', key: '*', access: 'write' }],
      createdAt: addHours(now, -5),
    },
    {
      id: 'lock-script-unknown', runId: 'run-unknown', operationId: 'op-unknown-script', scopeId: 'scope-agent', state: 'unknown',
      claims: [{ kind: 'workspace', authority: 'agent', key: 'task-demo-2', access: 'write' }],
      createdAt: addHours(now, -3),
    },
    {
      id: 'lock-probe-released', source: 'mcp-probe', serverId: 'mcp-22222222222222222222222222222222', serverRevision: 1,
      scopeId: 'probe-demo-2', state: 'released',
      claims: [{ kind: 'global', authority: 'external', key: '*', access: 'write' }],
      createdAt: addHours(now, -20), endedAt: addHours(now, -19),
      evidence: '探测容器已停止并回收。', decision: 'confirmed-stopped',
    },
    {
      id: 'lock-run-waiting', runId: 'run-pending', operationId: 'op-pending-write', scopeId: 'scope-root', state: 'waiting',
      claims: [{ kind: 'workspace', authority: 'agent', key: 'task-demo-1', access: 'write' }],
      createdAt: addHours(now, -1),
    },
  ]
  return {
    now,
    approvals,
    barriers,
    locks,
    operationsByRun: {
      'run-pending': [pendingOperation],
      'run-consumed': [consumedOperation],
      'run-denied': [deniedOperation],
      'run-unknown': [unknownOperation],
      'run-dispatched': [dispatchedOperation],
    },
    contextItemsByRun: {
      'run-pending': [{
        id: 'ctx-skill-demo', runId: 'run-pending', taskId: 'task-demo-1', source: 'skill',
        ref: { id: 'skill-demo-ops', revision: 1, digest: 'demo-skill-digest' },
        path: 'SKILL.md', digest: 'demo-skill-digest', content: '# 演示技能\n只作为资料载入，不授予权限。',
        createdAt: addHours(now, -1), eventSeq: '9007199254740993',
      }],
    },
    runs,
    revocations: [],
  }
}

let state: AgentApprovalsDataState = createAgentApprovalsSeed(new Date().toISOString())
let queueFull = false

/** 复位回种子；测试传固定基准时间，演示缺省用当前时间（到期倒计时才有意义）。 */
export function resetAgentApprovalsData(nowIso?: string): void {
  state = createAgentApprovalsSeed(nowIso ?? new Date().toISOString())
  queueFull = false
}

/** 测试钩子：模拟任务队列已满（服务端 429 queue-full）。 */
export function setAgentApprovalsQueueFull(flag: boolean): void {
  queueFull = flag
}

/** 测试钩子：推进演示时钟（过期清扫与决定时间戳以它为准）。 */
export function setAgentApprovalsClock(nowIso: string): void {
  state.now = nowIso
}

export function readAgentApprovalsState(): AgentApprovalsDataState {
  return state
}

export function readAgentApprovalsRunFact(runId: string): AgentApprovalsRunFact | undefined {
  return state.runs[runId]
}

export function readAgentApprovalsRevocations(): readonly AgentRevocationFact[] {
  return [...state.revocations]
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/** 过期清扫：对齐服务端 expireApprovals（capability_store.go:348）。 */
function sweepExpiries(): void {
  for (const approval of state.approvals) {
    if (approval.status !== 'pending' && approval.status !== 'approved') continue
    if (!expiryState(approval, state.now)) continue
    approval.status = 'expired'
    approval.decidedAt = state.now
    const run = state.runs[approval.runId]
    if (run !== undefined && run.status !== 'succeeded' && run.status !== 'failed' && run.status !== 'cancelled' && run.status !== 'interrupted') {
      run.status = run.workflowId !== undefined ? 'recovery-required' : 'failed'
      run.memoryStatus = 'stale'
      run.endReason = 'approval-expired'
      run.endedAt = state.now
      run.error = { code: 'approval-expired', message: '审批已过期，运行已结束' }
    }
  }
}

/** 列表读取：过期清扫 → workflowId 过滤 → pending/approved 优先、rowid 倒序 → 200 截断。 */
function readApprovals(workflowId?: string): readonly AgentApproval[] {
  sweepExpiries()
  const rowIndex = new Map(state.approvals.map((approval, index) => [approval.id, index]))
  const filtered = state.approvals.filter((approval) => workflowId === undefined || workflowId === '' || approval.workflowId === workflowId)
  const ordered = [...filtered].sort((left, right) => {
    const group = approvalOrderGroup(left.status) - approvalOrderGroup(right.status)
    if (group !== 0) return group
    return (rowIndex.get(right.id) ?? 0) - (rowIndex.get(left.id) ?? 0)
  })
  return clone(ordered.slice(0, 200))
}

/** 决定审批：逐句对齐服务端 Manager.Decide（capability_store.go:270）。 */
export function decideAgentApproval(approvalId: string, decision: 'approved' | 'denied'): AgentApproval {
  if (decision !== 'approved' && decision !== 'denied') {
    throw new AgentApprovalsDomainError('审批决定必须为 approved 或 denied', 'invalid-decision', 400)
  }
  sweepExpiries()
  const approval = state.approvals.find((item) => item.id === approvalId)
  if (approval === undefined) {
    throw new AgentApprovalsDomainError('审批不存在或已不可用', 'not-found', 404)
  }
  if (approval.decision === decision) return clone(approval)
  if (approval.status !== 'pending') {
    throw new AgentApprovalsDomainError('审批已处理、过期或撤销', 'decision-conflict')
  }
  const run = state.runs[approval.runId]
  if (run === undefined || run.status !== 'waiting-approval') {
    throw new AgentApprovalsDomainError('运行已不在审批等待状态', 'run-state-conflict')
  }
  if (decision === 'approved') {
    if (queueFull) {
      throw new AgentApprovalsDomainError('任务队列已满，审批保持待处理', 'queue-full', 429)
    }
    run.status = 'queued'
    run.phase = 'queued'
  } else {
    run.status = 'failed'
    run.memoryStatus = 'stale'
    run.endReason = 'approval-denied'
    run.endedAt = state.now
    run.error = { code: 'approval-denied', message: '操作者拒绝本次操作，运行已结束' }
  }
  approval.decision = decision
  approval.status = decision
  approval.decidedAt = state.now
  return clone(approval)
}

/** 屏障核实：对齐 Manager.Reconcile（capability_store.go:226）并联动释放租约。 */
export function reconcileAgentBarrier(barrierId: string, evidence: string, decision: 'confirmed-completed' | 'confirmed-stopped'): AgentExecutionBarrier {
  if (encoder.encode(evidence).length < 1 || encoder.encode(evidence).length > 8192 ||
    (decision !== 'confirmed-completed' && decision !== 'confirmed-stopped')) {
    throw new AgentApprovalsDomainError('必须提供外部核实证据及 confirmed-completed 或 confirmed-stopped 决定', 'invalid-reconciliation', 400)
  }
  const barrier = state.barriers.find((item) => item.id === barrierId)
  if (barrier === undefined) {
    throw new AgentApprovalsDomainError('执行屏障不存在或已不可用', 'not-found', 404)
  }
  if (barrier.status === 'reconciled') {
    if (barrier.decision === decision && barrier.evidence === evidence) return clone(barrier)
    throw new AgentApprovalsDomainError('该屏障已有不同核实决定', 'decision-conflict')
  }
  if (barrier.status !== 'unknown') {
    throw new AgentApprovalsDomainError('只能核实已标记结果未知的操作；在途操作必须先结束确认流程', 'barrier-state-conflict')
  }
  barrier.status = 'reconciled'
  barrier.decision = decision
  barrier.evidence = evidence
  barrier.reconciledAt = state.now
  const lease = state.locks.find((item) => item.operationId === barrier.operationId)
  if (lease !== undefined) {
    lease.state = 'released'
    lease.endedAt = state.now
    lease.evidence = evidence
    lease.decision = decision
  }
  return clone(barrier)
}

/** 探测租约核实：对齐 Manager.ReconcileProbeLease（probe_lifecycle.go:103）。 */
export function reconcileAgentLock(lockId: string, evidence: string, decision: 'confirmed-stopped'): AgentResourceLease {
  if (evidence.trim() === '' || encoder.encode(evidence).length > 8192 || decision !== 'confirmed-stopped') {
    throw new AgentApprovalsDomainError('探测租约核实必须提供外部停止证据与 confirmed-stopped 决定', 'invalid-reconciliation', 400)
  }
  const lease = state.locks.find((item) => item.id === lockId)
  if (lease === undefined) {
    throw new AgentApprovalsDomainError('资源租约不存在或已不可用', 'not-found', 404)
  }
  if (lease.source !== 'mcp-probe' || lease.operationId !== undefined || lease.runId !== undefined) {
    throw new AgentApprovalsDomainError('操作租约须通过对应执行屏障核实', 'lease-reconciliation-denied')
  }
  if (lease.state === 'released' && lease.evidence === evidence && lease.decision === decision) return clone(lease)
  if (lease.state !== 'unknown') {
    throw new AgentApprovalsDomainError('只能核实停止结果未知的探测租约', 'lease-state-conflict')
  }
  lease.state = 'released'
  lease.endedAt = state.now
  lease.evidence = evidence
  lease.decision = decision
  return clone(lease)
}

/** 四类能力撤销：对齐 Manager.Revoke（materials.go:120），重复幂等。 */
export function revokeAgentCapability(kind: AgentRevocationKind, id: string, revision: number, reason: string): { revoked: boolean } {
  if (id === '' || !Number.isSafeInteger(revision) || revision < 0 || encoder.encode(reason).length < 1 || encoder.encode(reason).length > 2048) {
    throw new AgentApprovalsDomainError('必须提供能力编号、修订和中文撤销原因', 'invalid-revocation', 400)
  }
  const existing = state.revocations.find((item) => item.kind === kind && item.id === id && item.revision === revision)
  if (existing === undefined) {
    state.revocations.push({ kind, id, revision, reason, revokedAt: state.now })
  }
  return { revoked: true }
}

export const agentApprovalsDataApi = {
  listApprovals: readApprovals,
  listBarriers(workflowId?: string): readonly AgentExecutionBarrier[] {
    const rowIndex = new Map(state.barriers.map((barrier, index) => [barrier.id, index]))
    const filtered = state.barriers.filter((barrier) => workflowId === undefined || workflowId === '' || barrier.workflowId === workflowId)
    const ordered = [...filtered].sort((left, right) => (rowIndex.get(right.id) ?? 0) - (rowIndex.get(left.id) ?? 0))
    return clone(ordered.slice(0, 200))
  },
  listLocks(): readonly AgentResourceLease[] {
    return clone(state.locks)
  },
  listOperations(runId: string): readonly AgentOperation[] {
    return clone(state.operationsByRun[runId] ?? [])
  },
  listContextItems(runId: string): readonly AgentContextItem[] {
    return clone(state.contextItemsByRun[runId] ?? [])
  },
}
