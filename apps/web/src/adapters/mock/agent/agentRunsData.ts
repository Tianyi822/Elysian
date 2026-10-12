import type {
  AgentModelProfile,
  RuntimeCall,
  RuntimeEvent,
  RuntimeJSONValue,
  RuntimeLimits,
  RuntimeRun,
  RuntimeRunStatus,
  RuntimeStep,
} from '@elysian/contracts'
import { RUNTIME_RUN_STATUSES, RUNTIME_TOOL_NAMES } from '@elysian/contracts'

/*
 * Ely 运行记录域的确定性数据集与演示状态机（agent-runs 模块所有）。
 *
 * 复现口径：种子相对固定基准时间生成，不含随机源；刷新页面经 reset 回种子。
 * 状态机规则对齐服务端事实（manager.go Submit/Cancel、query.go 分页语义）：
 * - seed 的 Run 冻结在各自的演示状态（含 waiting-approval / recovery-required /
 *   interrupted），不会因读取而漂移——过滤与分页断言因此稳定；
 * - 只有经 submitBatch 创建的 Run 会随虚拟时钟推进：queued → running → 逐步骤
 *   call/started、call/finished → succeeded；interrupted 永不自动重跑；
 * - cancel 对 queued/waiting-* 立即置 cancelled（200），对 running 只落
 *   cancelRequestedAt（202「已请求取消」），下一拍才裁决为 cancelled 终态；
 * - 分页游标与事件序号一律十进制字符串；种子含 2^53+1 级 rowid 用于验证大整数
 *   游标不经 number 截断。
 */

/** 演示虚拟时钟的基准（UTC 固定）；不读系统时间。 */
export const AGENT_RUNS_MOCK_BASE_TIME = '2026-10-10T08:00:00Z'
/** 每次读取推进的虚拟时钟步长；对应详情页 3 秒轮询节奏。 */
const TICK_MILLISECONDS = 3_000

export const AGENT_RUNS_MOCK_LIMITS: RuntimeLimits = {
  concurrency: 2, queueCapacity: 32, maxSteps: 16, inputBytes: 65536,
  callTimeoutSeconds: 30, runTimeoutSeconds: 600, resultBytes: 262144,
  runResultBytes: 2097152, logBytes: 1048576, frameBytes: 524288,
  retentionDays: 30, cancelGraceSeconds: 5, maxModelRequests: 16,
  modelTimeoutSeconds: 60, outputTokens: 4096, tokenBudget: 128000,
  userBytes: 32768, memoryBytes: 16384, modelResponseBytes: 524288,
}

/** 十进制字符串游标的数值比较（先规范化再比长与字典序，不经 number）。 */
export function compareMockCursors(a: string, b: string): number {
  const canon = (value: string) => value.replace(/^0+(?=\d)/, '')
  const left = canon(a)
  const right = canon(b)
  if (left === right) return 0
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left < right ? -1 : 1
}

type SeedRun = {
  run: RuntimeRun
  events: RuntimeEvent[]
  calls: RuntimeCall[]
  /** 列表分页游标（服务端 rowid 的十进制字符串形态）。 */
  rowid: string
  /** 冻结的演示状态不推进；submitBatch 产物与被取消过的 Run 会解冻。 */
  frozen: boolean
}

type RunsDataset = {
  /** 虚拟时钟（ISO 串）；每次读取 +3s。 */
  now: string
  order: number
  runs: SeedRun[]
  /** requestId → { runId, canonical }；canonical 只含 kind 与 steps，与 service 端一致。 */
  submissions: Map<string, { runId: string; canonical: string }>
}

let dataset: RunsDataset | undefined

function iso(base: string, offsetMs: number): string {
  return new Date(new Date(base).getTime() + offsetMs).toISOString()
}

function nextSeq(events: readonly RuntimeEvent[]): string {
  let max = '0'
  for (const event of events) {
    if (compareMockCursors(event.seq, max) > 0) max = event.seq
  }
  return String(BigInt(max) + 1n)
}

function eventOf(runId: string, seq: string, type: string, at: string, extra?: { callId?: string; stepIndex?: number; data?: RuntimeJSONValue }): RuntimeEvent {
  return {
    runId,
    seq,
    type,
    at,
    ...(extra?.callId === undefined ? {} : { callId: extra.callId }),
    ...(extra?.stepIndex === undefined ? {} : { stepIndex: extra.stepIndex }),
    ...(extra?.data === undefined ? {} : { data: extra.data }),
  }
}

function callOf(runId: string, stepIndex: number, tool: string, status: RuntimeRunStatus, at: string, extra?: { result?: RuntimeJSONValue; error?: RuntimeCall['error']; argumentsJson?: string; operationId?: string; modelRequestId?: string; modelCallId?: string }): RuntimeCall {
  return {
    id: `call-${runId}-${stepIndex}`,
    runId,
    tool,
    status,
    startedAt: at,
    endedAt: status === 'succeeded' || status === 'failed' ? at : undefined,
    stepIndex,
    args: {},
    truncated: false,
    ...(extra?.result === undefined ? {} : { result: extra.result }),
    ...(extra?.error === undefined ? {} : { error: extra.error }),
    ...(extra?.argumentsJson === undefined ? {} : { argumentsJson: extra.argumentsJson }),
    ...(extra?.operationId === undefined ? {} : { operationId: extra.operationId }),
    ...(extra?.modelRequestId === undefined ? {} : { modelRequestId: extra.modelRequestId }),
    ...(extra?.modelCallId === undefined ? {} : { modelCallId: extra.modelCallId }),
  }
}

/** 各步骤的演示结果（只读工具的固定摘要，字段与服务端 Docker 域一致但内容为演示事实）。 */
function stepResult(tool: string, index: number): RuntimeJSONValue {
  switch (tool) {
    case 'docker_containers_list':
      return { containers: [{ id: `demo-container-${index}`, name: `ely-demo-${index}`, state: 'running', image: 'nginx:1.27' }] }
    case 'docker_images_list':
      return { images: [{ id: `sha256:demo${index}`, repository: 'nginx', tag: '1.27', sizeBytes: 187_000_000 }] }
    case 'docker_policy_view':
      return { policy: { allowExec: false, allowedImages: ['nginx:1.27'], readOnly: true } }
    case 'docker_self_container':
      return { id: 'demo-panel', name: 'elysian-panel', state: 'running', readOnlyRoot: true }
    default:
      return { ok: true }
  }
}

const DEMO_MODEL: AgentModelProfile = {
  id: 'model-demo',
  revision: 3,
  name: '演示模型',
  baseUrl: 'https://demo.invalid/v1',
  model: 'demo-opus',
  provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 128000,
  outputTokens: 4096,
  capabilities: { text: true, tools: true, source: 'config' },
  active: true,
  hasCredential: true,
}

function buildSeedRuns(): SeedRun[] {
  const base = AGENT_RUNS_MOCK_BASE_TIME
  const runs: SeedRun[] = []

  const push = (seed: Omit<SeedRun, 'frozen'>): void => {
    runs.push({ ...seed, frozen: true })
  }

  // 1. 成功的 tool-batch（v1 驱动）：四步全绿，事件含 run/queued → run/started → call/* → run/succeeded。
  {
    const runId = 'run-batch-ok'
    const tools = [...RUNTIME_TOOL_NAMES]
    const events: RuntimeEvent[] = []
    const calls: RuntimeCall[] = []
    let at = base
    events.push(eventOf(runId, '1', 'run/queued', at))
    at = iso(at, 1_000)
    events.push(eventOf(runId, '2', 'run/started', at))
    tools.forEach((tool, index) => {
      const callAt = iso(at, (index + 1) * 1_000)
      calls.push(callOf(runId, index, tool, 'succeeded', callAt, { result: stepResult(tool, index) }))
      events.push(eventOf(runId, String(3 + index * 2), 'call/started', callAt, { callId: `call-${runId}-${index}`, stepIndex: index }))
      events.push(eventOf(runId, String(4 + index * 2), 'call/finished', iso(callAt, 500), { callId: `call-${runId}-${index}`, stepIndex: index }))
    })
    const endedAt = iso(at, 5_000)
    events.push(eventOf(runId, String(3 + tools.length * 2), 'run/succeeded', endedAt))
    push({
      run: {
        id: runId,
        taskId: 'task-batch-ok',
        status: 'succeeded',
        createdAt: base,
        startedAt: iso(base, 1_000),
        endedAt: endedAt,
        endReason: 'completed',
        driverVersion: 'v1',
        requestId: 'req-batch-ok',
        task: {
          id: 'task-batch-ok',
          requestId: 'req-batch-ok',
          kind: 'tool-batch',
          driverVersion: 'v1',
          createdAt: base,
          steps: tools.map((tool) => ({ tool, args: {} })),
        },
        limits: AGENT_RUNS_MOCK_LIMITS,
        usage: { calls: tools.length, resultBytes: 968 },
        lastSeq: String(3 + tools.length * 2),
      },
      events,
      calls,
      rowid: '9007199254741000',
    })
  }

  // 2. 失败的 tool-batch：docker_policy_view 报错（演示：策略通道未就绪）。
  {
    const runId = 'run-batch-failed'
    const events = [
      eventOf(runId, '1', 'run/queued', iso(base, -600_000)),
      eventOf(runId, '2', 'run/started', iso(base, -599_000)),
      eventOf(runId, '3', 'call/started', iso(base, -598_500), { callId: `call-${runId}-0`, stepIndex: 0 }),
      eventOf(runId, '4', 'call/finished', iso(base, -598_000), { callId: `call-${runId}-0`, stepIndex: 0 }),
      eventOf(runId, '5', 'call/started', iso(base, -597_500), { callId: `call-${runId}-1`, stepIndex: 1 }),
      eventOf(runId, '6', 'run/failed', iso(base, -597_000)),
    ]
    const calls = [
      callOf(runId, 0, 'docker_containers_list', 'succeeded', iso(base, -598_500), { result: stepResult('docker_containers_list', 0) }),
      callOf(runId, 1, 'docker_policy_view', 'failed', iso(base, -597_500), { error: { code: 'policy-unavailable', message: '安全策略通道暂不可用' } }),
    ]
    push({
      run: {
        id: runId,
        taskId: 'task-batch-failed',
        status: 'failed',
        createdAt: iso(base, -600_000),
        startedAt: iso(base, -599_000),
        endedAt: iso(base, -597_000),
        endReason: 'policy-unavailable',
        error: { code: 'policy-unavailable', message: '安全策略通道暂不可用' },
        driverVersion: 'v1',
        requestId: 'req-batch-failed',
        task: {
          id: 'task-batch-failed',
          requestId: 'req-batch-failed',
          kind: 'tool-batch',
          driverVersion: 'v1',
          createdAt: iso(base, -600_000),
          steps: [
            { tool: 'docker_containers_list', args: {} },
            { tool: 'docker_policy_view', args: {} },
          ],
        },
        limits: AGENT_RUNS_MOCK_LIMITS,
        usage: { calls: 2, resultBytes: 320 },
        lastSeq: '6',
      },
      events,
      calls,
      rowid: '9007199254740999',
    })
  }

  // 3. 已取消的 tool-batch：cancelRequestedAt 与终态同时保留（先请求取消、随后裁决）。
  {
    const runId = 'run-batch-cancelled'
    const events = [
      eventOf(runId, '1', 'run/queued', iso(base, -1_200_000)),
      eventOf(runId, '2', 'run/started', iso(base, -1_199_000)),
      eventOf(runId, '3', 'call/started', iso(base, -1_198_500), { callId: `call-${runId}-0`, stepIndex: 0 }),
      eventOf(runId, '4', 'run/cancel-requested', iso(base, -1_198_000)),
      eventOf(runId, '5', 'run/cancelled', iso(base, -1_197_000)),
    ]
    push({
      run: {
        id: runId,
        taskId: 'task-batch-cancelled',
        status: 'cancelled',
        createdAt: iso(base, -1_200_000),
        startedAt: iso(base, -1_199_000),
        endedAt: iso(base, -1_197_000),
        cancelRequestedAt: iso(base, -1_198_000),
        endReason: 'cancelled',
        driverVersion: 'v1',
        requestId: 'req-batch-cancelled',
        task: {
          id: 'task-batch-cancelled',
          requestId: 'req-batch-cancelled',
          kind: 'tool-batch',
          driverVersion: 'v1',
          createdAt: iso(base, -1_200_000),
          steps: [{ tool: 'docker_images_list', args: {} }],
        },
        limits: AGENT_RUNS_MOCK_LIMITS,
        usage: { calls: 0, resultBytes: 0 },
        lastSeq: '5',
      },
      events,
      calls: [callOf(runId, 0, 'docker_images_list', 'cancelled', iso(base, -1_198_500))],
      rowid: '9007199254740998',
    })
  }

  // 4. 执行中的 agent/v2 Run：phase=inference，含 argumentsJson 的工具调用在途。
  {
    const runId = 'run-agent-live'
    const events = [
      eventOf(runId, '1', 'run/queued', iso(base, -40_000)),
      eventOf(runId, '2', 'run/started', iso(base, -39_000)),
      eventOf(runId, '3', 'materials/selected', iso(base, -38_000), { data: { items: ['skill:log-analysis@5'] } }),
      eventOf(runId, '4', 'model/started', iso(base, -37_000)),
      eventOf(runId, '5', 'model/finished', iso(base, -36_000)),
      eventOf(runId, '6', 'call/started', iso(base, -35_000), { callId: `call-${runId}-0`, stepIndex: 0 }),
    ]
    const calls = [
      callOf(runId, 0, 'skill.exec.read_log', 'running', iso(base, -35_000), {
        argumentsJson: '{"path":"/var/log/nginx/error.log","tail":200,"sinceMinutes":30}',
        operationId: 'op-demo-0001',
        modelRequestId: 'mr-demo-0001',
        modelCallId: 'mc-demo-0001',
      }),
    ]
    push({
      run: {
        id: runId,
        taskId: 'task-agent-live',
        status: 'running',
        phase: 'inference',
        createdAt: iso(base, -40_000),
        startedAt: iso(base, -39_000),
        driverVersion: 'v2',
        sessionId: 'session-demo-1',
        runNumber: 2,
        requestId: 'req-agent-live',
        input: '梳理容器面板 30 分钟内的 5xx 激增原因，只读分析并给出证据。',
        activeMilliseconds: 35_000,
        model: DEMO_MODEL,
        limits: AGENT_RUNS_MOCK_LIMITS,
        usage: { calls: 0, resultBytes: 0, modelRequests: 1, estimatedTokens: 2350 },
        lastSeq: '6',
      },
      events,
      calls,
      rowid: '9007199254740997',
    })
  }

  // 5. 等待审批的 agent/v2 Run：phase=waiting-approval，工具调用停在 planned 侧的证据。
  {
    const runId = 'run-agent-approval'
    const events = [
      eventOf(runId, '1', 'run/queued', iso(base, -300_000)),
      eventOf(runId, '2', 'run/started', iso(base, -299_000)),
      eventOf(runId, '3', 'approval/request', iso(base, -298_000), { data: { operationId: 'op-demo-0002', tool: 'mcp.demo.restart_service' } }),
    ]
    push({
      run: {
        id: runId,
        taskId: 'task-agent-approval',
        status: 'waiting-approval',
        phase: 'waiting-approval',
        createdAt: iso(base, -300_000),
        startedAt: iso(base, -299_000),
        driverVersion: 'v2',
        sessionId: 'session-demo-1',
        runNumber: 1,
        requestId: 'req-agent-approval',
        input: '评估并重启异常的演示服务（需要审批）。',
        activeMilliseconds: 120_000,
        model: DEMO_MODEL,
        limits: AGENT_RUNS_MOCK_LIMITS,
        usage: { calls: 0, resultBytes: 0, modelRequests: 2, estimatedTokens: 4100 },
        lastSeq: '3',
      },
      events,
      calls: [],
      rowid: '9007199254740996',
    })
  }

  // 6. 等待资源的 agent/v2 Run（执行容器额度被占用）。
  {
    const runId = 'run-agent-resource'
    push({
      run: {
        id: runId,
        taskId: 'task-agent-resource',
        status: 'waiting-resource',
        phase: 'waiting-resource',
        createdAt: iso(base, -720_000),
        startedAt: iso(base, -719_000),
        driverVersion: 'v2',
        sessionId: 'session-demo-2',
        runNumber: 1,
        requestId: 'req-agent-resource',
        input: '在执行容器里核对该脚本的输出。',
        activeMilliseconds: 90_000,
        model: DEMO_MODEL,
        limits: AGENT_RUNS_MOCK_LIMITS,
        usage: { calls: 0, resultBytes: 0, modelRequests: 1, estimatedTokens: 1600 },
        lastSeq: '2',
      },
      events: [
        eventOf(runId, '1', 'run/queued', iso(base, -720_000)),
        eventOf(runId, '2', 'run/started', iso(base, -719_000)),
      ],
      calls: [],
      rowid: '9007199254740995',
    })
  }

  // 7. 面板重启中断的 agent/v2 Run：不自动重跑，文案注明原因。
  {
    const runId = 'run-agent-interrupted'
    const reason = { code: 'panel-restarted', message: '面板进程重启，运行被中断；不会自动重跑' }
    push({
      run: {
        id: runId,
        taskId: 'task-agent-interrupted',
        status: 'interrupted',
        phase: 'completed',
        createdAt: iso(base, -86_400_000),
        startedAt: iso(base, -86_399_000),
        endedAt: iso(base, -86_398_000),
        endReason: 'panel-restarted',
        error: reason,
        driverVersion: 'v2',
        sessionId: 'session-demo-2',
        runNumber: 1,
        requestId: 'req-agent-interrupted',
        input: '昨日巡检：核对全部容器镜像的更新状态。',
        activeMilliseconds: 45_000,
        model: DEMO_MODEL,
        limits: AGENT_RUNS_MOCK_LIMITS,
        usage: { calls: 1, resultBytes: 210, modelRequests: 1, estimatedTokens: 1900 },
        lastSeq: '4',
      },
      events: [
        eventOf(runId, '1', 'run/queued', iso(base, -86_400_000)),
        eventOf(runId, '2', 'run/started', iso(base, -86_399_000)),
        eventOf(runId, '3', 'call/started', iso(base, -86_398_500), { callId: `call-${runId}-0`, stepIndex: 0 }),
        eventOf(runId, '4', 'run/interrupted', iso(base, -86_398_000), { data: { code: 'panel-restarted' } }),
      ],
      calls: [callOf(runId, 0, 'docker_images_list', 'interrupted', iso(base, -86_398_500), { argumentsJson: '{}' })],
      rowid: '9007199254740994',
    })
  }

  // 8. 等待人工恢复的 agent/v2 Run（结果未知，进入 recovery-required）。
  {
    const runId = 'run-agent-recovery'
    push({
      run: {
        id: runId,
        taskId: 'task-agent-recovery',
        status: 'recovery-required',
        phase: 'completed',
        createdAt: iso(base, -172_800_000),
        startedAt: iso(base, -172_799_000),
        endReason: 'worker-lost',
        error: { code: 'worker-lost', message: 'Worker 失联，派发结果未知；等待人工核实恢复' },
        driverVersion: 'v2',
        sessionId: 'session-demo-3',
        runNumber: 1,
        requestId: 'req-agent-recovery',
        input: '批量核对三个站点的证书到期时间。',
        activeMilliseconds: 210_000,
        model: DEMO_MODEL,
        limits: AGENT_RUNS_MOCK_LIMITS,
        usage: { calls: 2, resultBytes: 640, modelRequests: 2, estimatedTokens: 3300 },
        lastSeq: '5',
      },
      events: [
        eventOf(runId, '1', 'run/queued', iso(base, -172_800_000)),
        eventOf(runId, '2', 'run/started', iso(base, -172_799_000)),
        eventOf(runId, '3', 'call/started', iso(base, -172_798_500), { callId: `call-${runId}-0`, stepIndex: 0 }),
        eventOf(runId, '4', 'run/interrupted', iso(base, -172_798_000)),
        eventOf(runId, '5', 'workflow/recovery-required', iso(base, -172_797_000)),
      ],
      calls: [callOf(runId, 0, 'docker_containers_list', 'interrupted', iso(base, -172_798_500), { argumentsJson: '{}' })],
      rowid: '9007199254740993',
    })
  }

  // 9. 成功的 agent/v2 Run：含供应商实际 token（与估算并存）与记忆整理事件。
  {
    const runId = 'run-agent-done'
    push({
      run: {
        id: runId,
        taskId: 'task-agent-done',
        status: 'succeeded',
        phase: 'completed',
        createdAt: iso(base, -600_000),
        startedAt: iso(base, -599_000),
        endedAt: iso(base, -570_000),
        endReason: 'completed',
        driverVersion: 'v2',
        sessionId: 'session-demo-1',
        runNumber: 1,
        requestId: 'req-agent-done',
        input: '总结上一个任务的容器异常证据。',
        activeMilliseconds: 29_000,
        model: DEMO_MODEL,
        memoryStatus: 'updated',
        limits: AGENT_RUNS_MOCK_LIMITS,
        usage: { calls: 1, resultBytes: 512, modelRequests: 3, tokens: 6100, estimatedTokens: 5900, actualTokens: 6104, cachedTokens: 2048 },
        lastSeq: '7',
      },
      events: [
        eventOf(runId, '1', 'run/queued', iso(base, -600_000)),
        eventOf(runId, '2', 'run/started', iso(base, -599_000)),
        eventOf(runId, '3', 'model/started', iso(base, -598_000)),
        eventOf(runId, '4', 'model/finished', iso(base, -596_000)),
        eventOf(runId, '5', 'call/started', iso(base, -595_000), { callId: `call-${runId}-0`, stepIndex: 0 }),
        eventOf(runId, '6', 'call/finished', iso(base, -594_000), { callId: `call-${runId}-0`, stepIndex: 0 }),
        eventOf(runId, '7', 'memory/updated', iso(base, -571_000)),
      ],
      calls: [callOf(runId, 0, 'docker_containers_list', 'succeeded', iso(base, -595_000), { result: stepResult('docker_containers_list', 0), argumentsJson: '{}' })],
      rowid: '9007199254740992',
    })
  }

  // 10. 成功的工作流 Run：携带 workflow 定位字段，供 workflowId 过滤演示。
  {
    const runId = 'run-workflow-ok'
    push({
      run: {
        id: runId,
        taskId: 'task-workflow-ok',
        status: 'succeeded',
        phase: 'completed',
        createdAt: iso(base, -3_600_000),
        startedAt: iso(base, -3_599_000),
        endedAt: iso(base, -3_500_000),
        endReason: 'completed',
        driverVersion: 'v2',
        workflowId: 'wf-demo-1',
        workflowStepId: 'node-collect',
        workflowAttempt: 1,
        scopeId: 'wf-demo-1/node-collect',
        nodeId: 'node-collect',
        sessionId: 'session-demo-3',
        runNumber: 1,
        requestId: 'req-workflow-ok',
        input: '收集三个站点的可用性事实。',
        activeMilliseconds: 99_000,
        model: DEMO_MODEL,
        limits: AGENT_RUNS_MOCK_LIMITS,
        usage: { calls: 2, resultBytes: 830, modelRequests: 2, estimatedTokens: 2600 },
        lastSeq: '4',
      },
      events: [
        eventOf(runId, '1', 'run/queued', iso(base, -3_600_000)),
        eventOf(runId, '2', 'workflow/accepted', iso(base, -3_599_000)),
        eventOf(runId, '3', 'run/started', iso(base, -3_590_000)),
        eventOf(runId, '4', 'run/succeeded', iso(base, -3_500_000)),
      ],
      calls: [],
      rowid: '9007199254740991',
    })
  }

  // 11-13. 三条历史成功批次，撑起分页第二页（rowid 常规量级）。
  for (let index = 0; index < 3; index += 1) {
    const runId = `run-batch-history-${index}`
    const at = iso(base, -(7_200_000 + index * 600_000))
    push({
      run: {
        id: runId,
        taskId: `task-batch-history-${index}`,
        status: 'succeeded',
        createdAt: at,
        startedAt: iso(at, 1_000),
        endedAt: iso(at, 4_000),
        endReason: 'completed',
        driverVersion: 'v1',
        requestId: `req-batch-history-${index}`,
        task: {
          id: `task-batch-history-${index}`,
          requestId: `req-batch-history-${index}`,
          kind: 'tool-batch',
          driverVersion: 'v1',
          createdAt: at,
          steps: [{ tool: 'docker_self_container', args: {} }],
        },
        limits: AGENT_RUNS_MOCK_LIMITS,
        usage: { calls: 1, resultBytes: 96 },
        lastSeq: '4',
      },
      events: [
        eventOf(runId, '1', 'run/queued', at),
        eventOf(runId, '2', 'run/started', iso(at, 1_000)),
        eventOf(runId, '3', 'call/started', iso(at, 2_000), { callId: `call-${runId}-0`, stepIndex: 0 }),
        eventOf(runId, '4', 'call/finished', iso(at, 3_000), { callId: `call-${runId}-0`, stepIndex: 0 }),
      ],
      calls: [callOf(runId, 0, 'docker_self_container', 'succeeded', iso(at, 2_000), { result: stepResult('docker_self_container', 0) })],
      rowid: String(7000 + index),
    })
  }

  // 14. 冻结的排队中批次：补齐九态演示；种子冻结，不随读取推进。
  {
    const runId = 'run-batch-queued'
    push({
      run: {
        id: runId,
        taskId: 'task-batch-queued',
        status: 'queued',
        createdAt: iso(base, -120_000),
        driverVersion: 'v1',
        requestId: 'req-batch-queued',
        task: {
          id: 'task-batch-queued',
          requestId: 'req-batch-queued',
          kind: 'tool-batch',
          driverVersion: 'v1',
          createdAt: iso(base, -120_000),
          steps: [{ tool: 'docker_containers_list', args: {} }],
        },
        limits: AGENT_RUNS_MOCK_LIMITS,
        usage: { calls: 0, resultBytes: 0 },
        lastSeq: '1',
      },
      events: [eventOf(runId, '1', 'run/queued', iso(base, -120_000))],
      calls: [],
      rowid: '6000',
    })
  }

  return runs
}

function freshDataset(): RunsDataset {
  return { now: AGENT_RUNS_MOCK_BASE_TIME, order: 0, runs: buildSeedRuns(), submissions: new Map() }
}

/** 测试与页面挂载前的复位出口；保持地基聚合复位（resetAgentSeeds）可用。 */
export function resetAgentRunsData(): void {
  dataset = freshDataset()
}

function state(): RunsDataset {
  if (dataset === undefined) dataset = freshDataset()
  return dataset
}

/** 找不到实体时服务端口径的中文错误。 */
export class AgentRunsMockNotFound extends Error {
  constructor(label: string, id: string) {
    super(`演示数据中不存在 ${label} ${id}`)
    this.name = 'AgentRunsMockNotFound'
  }
}

function findRun(runId: string): SeedRun {
  const hit = state().runs.find((entry) => entry.run.id === runId)
  if (hit === undefined) throw new AgentRunsMockNotFound('Run', runId)
  return hit
}

function emit(seed: SeedRun, type: string, extra?: { callId?: string; stepIndex?: number; data?: RuntimeJSONValue }): void {
  const seq = nextSeq(seed.events)
  seed.events.push(eventOf(seed.run.id, seq, type, state().now, extra))
  seed.run.lastSeq = seq
}

function activeCount(): number {
  return state().runs.filter((entry) =>
    entry.run.status === 'queued' || entry.run.status === 'running').length
}

/**
 * 推进一台 Run 的演示状态机。只有未冻结的 Run（submitBatch 产物、被取消过的
 * Run）会推进；种子一律冻结，保证过滤与分页断言稳定。
 */
function advanceRun(seed: SeedRun): void {
  const run = seed.run
  if (seed.frozen) return
  if (run.status !== 'queued' && run.status !== 'running') return
  // 已请求取消且仍在执行：下一拍裁决为 cancelled 终态（宽限期演示为一拍）。
  if (run.cancelRequestedAt !== undefined) {
    run.status = 'cancelled'
    run.endReason = 'cancelled'
    run.endedAt = state().now
    run.phase = 'completed'
    for (const call of seed.calls) {
      if (call.status === 'running' || call.status === 'queued') call.status = 'cancelled'
    }
    emit(seed, 'run/cancelled')
    return
  }
  const steps = run.task?.steps ?? []
  if (run.status === 'queued') {
    run.status = 'running'
    run.startedAt = state().now
    run.phase = run.driverVersion === 'v2' ? 'inference' : undefined
    emit(seed, 'run/started')
    if (steps.length > 0 && steps[0] !== undefined) {
      seed.calls.push(callOf(run.id, 0, steps[0].tool, 'running', state().now, run.driverVersion === 'v2' ? { argumentsJson: '{}' } : undefined))
      emit(seed, 'call/started', { callId: `call-${run.id}-0`, stepIndex: 0 })
    }
    return
  }
  const runningIndex = seed.calls.findIndex((call) => call.status === 'running')
  const runningCall = runningIndex >= 0 ? seed.calls[runningIndex] : undefined
  if (runningCall !== undefined) {
    const call = runningCall
    call.status = 'succeeded'
    call.endedAt = state().now
    call.result = stepResult(call.tool, call.stepIndex)
    run.usage = { ...run.usage, calls: run.usage.calls + 1, resultBytes: run.usage.resultBytes + 128 }
    emit(seed, 'call/finished', { callId: call.id, stepIndex: call.stepIndex })
    const nextIndex = call.stepIndex + 1
    const nextStep = nextIndex < steps.length ? steps[nextIndex] : undefined
    if (nextStep !== undefined) {
      seed.calls.push(callOf(run.id, nextIndex, nextStep.tool, 'running', state().now, run.driverVersion === 'v2' ? { argumentsJson: '{}' } : undefined))
      emit(seed, 'call/started', { callId: `call-${run.id}-${nextIndex}`, stepIndex: nextIndex })
    }
    return
  }
  // 全部步骤完成：v2 先经 checkpoint、final-memory 两拍整理记忆再收尾。
  if (run.driverVersion === 'v2' && (run.phase === 'inference' || run.phase === undefined)) {
    run.phase = 'checkpoint'
    emit(seed, 'memory/updated')
    return
  }
  if (run.driverVersion === 'v2' && run.phase === 'checkpoint') {
    run.phase = 'final-memory'
    emit(seed, 'memory/updated')
    return
  }
  run.status = 'succeeded'
  run.endReason = 'completed'
  run.endedAt = state().now
  run.phase = 'completed'
  if (run.driverVersion === 'v2') run.memoryStatus = 'updated'
  emit(seed, 'run/succeeded')
}

/** 每次读取推进一拍虚拟时钟；状态机以拍数而非真实时间判定，保证确定性。 */
function tick(): void {
  const current = state()
  current.now = iso(current.now, TICK_MILLISECONDS)
  for (const seed of current.runs) {
    advanceRun(seed)
  }
}

/*
 * 列表查询：rowid 降序、rowid < cursor 语义（query.go list）。
 * status/requestId/sessionId/taskId/workflowId 全部精确单值过滤；
 * limit 缺省 50、1..200；hasMore 时 nextCursor = 当页最后一条的 rowid。
 */
export function mockListRuns(query: {
  status?: string
  requestId?: string
  sessionId?: string
  taskId?: string
  workflowId?: string
  cursor?: string
  limit?: number
}, additionalRuns: readonly { run: RuntimeRun; rowid: string }[] = []): { items: readonly RuntimeRun[]; nextCursor: string; hasMore: boolean } {
  tick()
  const limit = query.limit ?? 50
  if (limit < 1 || limit > 200) throw new Error('每页条数必须在 1 到 200 之间')
  if (query.status !== undefined && query.status !== '' && !(RUNTIME_RUN_STATUSES as readonly string[]).includes(query.status)) {
    throw new Error('运行状态无效')
  }
  if (query.cursor !== undefined && query.cursor !== '' && !/^(0|[1-9][0-9]*)$/.test(query.cursor)) {
    throw new Error('分页游标无效')
  }
  const cursor = query.cursor ?? ''
  const rows = [...state().runs, ...additionalRuns]
    .filter((entry) => (cursor === '' ? true : compareMockCursors(entry.rowid, cursor) < 0))
    .filter((entry) => (query.status === undefined || query.status === '' ? true : entry.run.status === query.status))
    .filter((entry) => (query.requestId === undefined || query.requestId === '' ? true : entry.run.requestId === query.requestId))
    .filter((entry) => (query.sessionId === undefined || query.sessionId === '' ? true : entry.run.sessionId === query.sessionId))
    .filter((entry) => (query.taskId === undefined || query.taskId === '' ? true : entry.run.taskId === query.taskId))
    .filter((entry) => (query.workflowId === undefined || query.workflowId === '' ? true : entry.run.workflowId === query.workflowId))
    .sort((left, right) => compareMockCursors(right.rowid, left.rowid))
  const slice = rows.slice(0, limit)
  const hasMore = rows.length > limit
  const last = slice.length > 0 ? slice[slice.length - 1] : undefined
  return {
    items: slice.map((entry) => cloneRun(entry.run)),
    nextCursor: hasMore && last !== undefined ? last.rowid : '',
    hasMore,
  }
}

function cloneRun(run: RuntimeRun): RuntimeRun {
  return structuredClone(run)
}

export function mockGetRun(runId: string): RuntimeRun {
  tick()
  return cloneRun(findRun(runId).run)
}

/** calls 分页：step_index 升序、step_index >= cursor；hasMore 时 nextCursor = 最后一步 +1（query.go calls）。 */
export function mockListRunCalls(runId: string, query: { cursor?: string; limit?: number }): { items: readonly RuntimeCall[]; nextCursor: string; hasMore: boolean } {
  tick()
  const seed = findRun(runId)
  const limit = query.limit ?? 50
  if (limit < 1 || limit > 200) throw new Error('每页条数必须在 1 到 200 之间')
  if (query.cursor !== undefined && query.cursor !== '' && !/^(0|[1-9][0-9]*)$/.test(query.cursor)) {
    throw new Error('分页游标无效')
  }
  const cursor = query.cursor === undefined || query.cursor === '' ? 0 : Number(query.cursor)
  const rows = seed.calls
    .filter((call) => call.stepIndex >= cursor)
    .sort((left, right) => left.stepIndex - right.stepIndex)
  const slice = rows.slice(0, limit)
  const hasMore = rows.length > limit
  const last = slice.length > 0 ? slice[slice.length - 1] : undefined
  return {
    items: structuredClone(slice),
    nextCursor: hasMore && last !== undefined ? String(last.stepIndex + 1) : '',
    hasMore,
  }
}

/** events 增量：seq > after 升序；空页保留当前游标，越 过 lastSeq 报 future-cursor（query.go events）。 */
export function mockListRunEvents(runId: string, query: { after?: string; limit?: number }): { items: readonly RuntimeEvent[]; nextCursor: string; hasMore: boolean } {
  tick()
  const seed = findRun(runId)
  const limit = query.limit ?? 100
  if (limit < 1 || limit > 200) throw new Error('每页条数必须在 1 到 200 之间')
  const after = query.after ?? ''
  if (after !== '' && !/^(0|[1-9][0-9]*)$/.test(after)) throw new Error('事件序号必须为非负十进制字符串')
  if (after !== '' && compareMockCursors(after, seed.run.lastSeq) > 0) {
    throw new Error('事件游标超过当前运行进度')
  }
  const rows = seed.events
    .filter((event) => (after === '' ? true : compareMockCursors(event.seq, after) > 0))
    .sort((left, right) => compareMockCursors(left.seq, right.seq))
  const slice = rows.slice(0, limit)
  const hasMore = rows.length > limit
  const last = slice.length > 0 ? slice[slice.length - 1] : undefined
  return {
    items: structuredClone(slice),
    nextCursor: last !== undefined ? last.seq : (after === '' ? '0' : after),
    hasMore,
  }
}

function canonicalOf(kind: string, steps: readonly RuntimeStep[]): string {
  return JSON.stringify({ kind, steps: steps.map((step) => ({ tool: step.tool, args: {} })) })
}

/** submitBatch：requestId 幂等；同键不同输入 409 request-conflict（manager.go Submit）。 */
export function mockSubmitBatch(input: { requestId: string; kind: string; steps: readonly { tool: string; args?: Readonly<Record<string, unknown>> }[] }): RuntimeRun {
  const current = state()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestId)) {
    throw new Error('请求标识必须为 1 到 128 位字母、数字或 ._:-')
  }
  if (input.kind !== 'tool-batch') throw new Error('只支持 tool-batch 顺序工具任务')
  if (input.steps.length < 1 || input.steps.length > AGENT_RUNS_MOCK_LIMITS.maxSteps) {
    throw new Error('任务步骤数必须在允许范围内')
  }
  const steps: RuntimeStep[] = []
  for (const step of input.steps) {
    if (!(RUNTIME_TOOL_NAMES as readonly string[]).includes(step.tool)) {
      throw new Error('任务包含未获准的工具')
    }
    if (step.args !== undefined && Object.keys(step.args).length !== 0) {
      throw new Error('首版只读工具不接受参数')
    }
    steps.push({ tool: step.tool as RuntimeStep['tool'], args: {} })
  }
  const canonical = canonicalOf(input.kind, steps)
  const previous = current.submissions.get(input.requestId)
  if (previous !== undefined) {
    if (previous.canonical !== canonical) {
      throw new Error('请求标识已用于不同的任务输入')
    }
    return cloneRun(findRun(previous.runId).run)
  }
  if (activeCount() >= AGENT_RUNS_MOCK_LIMITS.queueCapacity) {
    throw new Error('任务队列已满，请稍后重试')
  }
  const order = ++current.order
  const taskId = `task-mock-${order}`
  const runId = `run-mock-${order}`
  const seed: SeedRun = {
    run: {
      id: runId,
      taskId,
      status: 'queued',
      createdAt: current.now,
      driverVersion: 'v1',
      requestId: input.requestId,
      task: { id: taskId, requestId: input.requestId, kind: 'tool-batch', driverVersion: 'v1', createdAt: current.now, steps },
      limits: AGENT_RUNS_MOCK_LIMITS,
      usage: { calls: 0, resultBytes: 0 },
      lastSeq: '0',
    },
    events: [],
    calls: [],
    rowid: String(9_000_000_000_000 + order),
    frozen: false,
  }
  current.runs.push(seed)
  current.submissions.set(input.requestId, { runId, canonical })
  emit(seed, 'run/queued')
  return cloneRun(seed.run)
}

/** cancelRun：queued/waiting-* 立即 cancelled；running 仅落 cancelRequestedAt（manager.go Cancel）。 */
export function mockCancelRun(runId: string): RuntimeRun {
  const seed = findRun(runId)
  const run = seed.run
  const terminal = run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted'
  if (!terminal && run.cancelRequestedAt === undefined) {
    run.cancelRequestedAt = state().now
    emit(seed, 'run/cancel-requested')
    if (run.status !== 'running') {
      run.status = 'cancelled'
      run.endReason = 'cancelled'
      run.endedAt = run.cancelRequestedAt
      run.phase = 'completed'
      emit(seed, 'run/cancelled')
    } else {
      // running：解冻状态机，下一拍裁决（真实语义为取消宽限期内停止）。
      seed.frozen = false
    }
  }
  return cloneRun(run)
}

/** 供种子断言使用的只读快照（不推进时钟）。 */
export function agentRunsSeedSnapshot(): readonly RuntimeRun[] {
  return state().runs.map((entry) => cloneRun(entry.run))
}

/** 测试专用：当前虚拟时钟（ISO 串）。 */
export function agentRunsMockNow(): string {
  return state().now
}
