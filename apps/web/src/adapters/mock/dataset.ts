import type {
  Alert,
  AgentRun,
  ApprovalOutcome,
  ApprovalRequest,
  ApprovalStatus,
  AuditRecord,
  Evidence,
  ExecutionResult,
  Finding,
  Incident,
  IncidentListRow,
  IncidentStatus,
  MetricSummary,
  ModuleStatus,
  PendingTask,
  ProposedAction,
  RiskLevel,
  RunStatus,
  Severity,
  Skill,
  Step,
  TimelineEntry,
  ToolCall,
  Turn,
} from '@elysian/contracts'
import {
  addMinutes,
  createRandom,
  intBetween,
  minutesBefore,
  pick,
  pickWeighted,
  shuffle,
} from './seed'

/**
 * 一份确定性的演示数据集。所有时间都相对下面这个基准时刻推算，
 * 所有随机都来自固定种子，因此两次构建的结果逐字段一致。
 */
export const DATASET_SEED = 20_260_912
export const DATASET_BASE_TIME = '2026-09-12T08:00:00.000Z'

/**
 * 演示数据集。字段是可变的：审批与技能启停会在运行期改写它，
 * 适配层接口本身就承诺了这一点（`setEnabled`、`decide`），
 * 因此这里不假装它是只读的，readonly 只体现在适配层返回给界面的那一侧。
 */
export type MockDataset = {
  incidents: Incident[]
  alerts: Alert[]
  pendingTasks: PendingTask[]
  runs: AgentRun[]
  approvals: ApprovalRequest[]
  skills: Skill[]
  audit: AuditRecord[]
  moduleStatuses: ModuleStatus[]
}

const SERVICES = [
  'order-service',
  'payment-gateway',
  'user-profile',
  'search-index',
  'notification-worker',
  'inventory-api',
  'billing-cron',
  'cdn-edge',
] as const

const SOURCES = [
  'alertmanager',
  'prometheus',
  'kubernetes',
  'cloud',
  'database',
  'manual',
  'webhook',
] as const

const OWNERS = ['张岚', '李维', '陈默', '王沐', '赵行'] as const

/** 本期在 mock 中有活跃运行的五个职责模块。 */
const ACTIVE_MODULE_IDS = [
  'coordination',
  'incident-command',
  'security-review',
  'observability-analysis',
  'rapid-response',
] as const

/** 本期没有活跃运行的八个模块。 */
const IDLE_MODULE_IDS = [
  'resource-governance',
  'automation-orchestration',
  'fault-drill',
  'recovery-engineering',
  'root-cause-diagnosis',
  'knowledge-presentation',
  'change-governance',
  'skill-management',
] as const

/** 会产生进行中运行的事故状态。 */
function isActiveIncidentStatus(status: IncidentStatus): boolean {
  return status === 'analyzing' || status === 'awaiting-approval' || status === 'mitigating'
}

function activeModuleAt(index: number): string {
  return ACTIVE_MODULE_IDS[index % ACTIVE_MODULE_IDS.length] ?? 'coordination'
}

const INCIDENT_TITLES = [
  '订单服务 P99 延迟突增，错误率同步上升',
  '支付网关回调超时率超过阈值',
  '用户资料接口 5xx 比例升高',
  '搜索索引写入堆积，查询延迟上升',
  '通知队列消费延迟持续增长',
  '库存接口连接池耗尽',
  '计费定时任务连续失败',
  'CDN 边缘节点回源失败率上升',
  '数据库主从延迟超过告警线',
  '鉴权服务证书即将到期',
  '灰度批次错误率高于基线',
  '对象存储写入限流触发',
] as const

const ALERT_SUMMARIES = [
  'CPU 使用率持续 10 分钟高于 85%',
  '容器重启次数在 5 分钟内超过 3 次',
  '接口错误率超过 1% 持续 5 分钟',
  '磁盘可用空间低于 15%',
  '连接数接近上限',
  '队列积压超过 1 万条',
] as const

const PENDING_TASKS = [
  '季度容量水位复核',
  '证书轮换窗口确认',
  '数据库慢查询清单确认',
  '值班交接单补充',
  '备份恢复演练排期',
] as const

const TOOL_NAMES = [
  'metrics.query',
  'logs.search',
  'k8s.pod.list',
  'k8s.deployment.describe',
  'changes.list',
  'topology.lookup',
  'alerts.silence.propose',
] as const

const SKILL_SEEDS: ReadonlyArray<{
  id: string
  name: string
  responsibility: string
  version: string
  capabilities: readonly string[]
  riskLevel: RiskLevel
  enabled: boolean
}> = [
  { id: 'k8s-pod-ops', name: 'Kubernetes Pod 运维', responsibility: 'Pod 生命周期与异常处置', version: '2.4.1', capabilities: ['k8s.pod.list', 'k8s.pod.restart', 'k8s.pod.logs'], riskLevel: 'high', enabled: true },
  { id: 'k8s-workload-scale', name: 'Kubernetes 工作负载扩缩容', responsibility: '副本数与资源配额调整', version: '1.9.0', capabilities: ['k8s.deployment.scale', 'k8s.hpa.describe'], riskLevel: 'high', enabled: true },
  { id: 'cloud-instance-lifecycle', name: '云主机生命周期', responsibility: '云主机启停与规格变更', version: '3.1.2', capabilities: ['cloud.instance.list', 'cloud.instance.stop', 'cloud.instance.resize'], riskLevel: 'critical', enabled: false },
  { id: 'db-slow-query', name: '数据库慢查询分析', responsibility: '慢查询定位与索引建议', version: '1.6.3', capabilities: ['db.slowlog.query', 'db.index.suggest'], riskLevel: 'medium', enabled: true },
  { id: 'log-search', name: '日志检索', responsibility: '跨服务日志检索与聚合', version: '4.0.0', capabilities: ['logs.search', 'logs.aggregate'], riskLevel: 'low', enabled: true },
  { id: 'metrics-query', name: '指标查询', responsibility: '指标读取与趋势对比', version: '4.2.0', capabilities: ['metrics.query', 'metrics.compare'], riskLevel: 'low', enabled: true },
  { id: 'alert-silence', name: '告警静默管理', responsibility: '告警抑制与静默窗口', version: '1.3.5', capabilities: ['alerts.silence.create', 'alerts.silence.list'], riskLevel: 'medium', enabled: true },
  { id: 'change-query', name: '变更单查询', responsibility: '变更记录与发布窗口查询', version: '2.0.1', capabilities: ['changes.list', 'changes.window.check'], riskLevel: 'low', enabled: true },
  { id: 'backup-restore', name: '备份与恢复', responsibility: '备份状态查询与恢复编排', version: '2.2.0', capabilities: ['backup.status', 'restore.propose'], riskLevel: 'critical', enabled: false },
  { id: 'network-policy-check', name: '网络策略检查', responsibility: '网络策略与连通性核对', version: '1.1.4', capabilities: ['net.policy.list', 'net.probe'], riskLevel: 'low', enabled: true },
  { id: 'cert-rotation', name: '证书轮换', responsibility: '证书有效期检查与轮换编排', version: '1.8.2', capabilities: ['cert.list', 'cert.rotate.propose'], riskLevel: 'high', enabled: true },
  { id: 'capacity-analysis', name: '容量水位分析', responsibility: '容量水位与增长趋势分析', version: '2.5.0', capabilities: ['capacity.waterline', 'capacity.forecast'], riskLevel: 'low', enabled: true },
  { id: 'gray-release', name: '灰度发布编排', responsibility: '灰度批次推进与回滚编排', version: '3.0.0', capabilities: ['release.gray.advance', 'release.rollback.propose'], riskLevel: 'critical', enabled: false },
  { id: 'fault-injection', name: '故障注入演练', responsibility: '受控故障注入与演练执行', version: '0.9.3', capabilities: ['chaos.inject', 'chaos.report'], riskLevel: 'critical', enabled: false },
]

const EVIDENCE_KINDS = ['metric', 'log', 'change', 'topology'] as const

const FINDING_TEMPLATES = [
  '指标曲线与最近一次发布窗口高度重合',
  '错误日志集中在单一实例，疑似该实例资源不足',
  '调用链上游超时先于本服务错误出现',
  '连接池占用与慢查询数量同步上升',
  '变更记录显示同一时间有配置推送',
] as const

const ACTION_TEMPLATES: ReadonlyArray<{
  title: string
  target: (service: string) => string
  parameters: Readonly<Record<string, string>>
  blastRadius: string
  riskLevel: RiskLevel
}> = [
  {
    title: '重启异常实例',
    target: (service) => `${service}/deployment`,
    parameters: { replicas: '3', strategy: '滚动重启', maxUnavailable: '1' },
    blastRadius: '单服务 3 个副本，短暂容量下降 1/3',
    riskLevel: 'high',
  },
  {
    title: '临时提高副本数',
    target: (service) => `${service}/deployment`,
    parameters: { from: '3', to: '5' },
    blastRadius: '单服务新增 2 个副本，成本小幅上升',
    riskLevel: 'medium',
  },
  {
    title: '回滚最近一次发布',
    target: (service) => `${service}/release`,
    parameters: { revision: '当前版本前一版', mode: '全部流量' },
    blastRadius: '全量流量回退，可能丢失新版本数据写入',
    riskLevel: 'critical',
  },
  {
    title: '切换只读模式',
    target: (service) => `${service}/feature-flag`,
    parameters: { flag: 'write-path', value: 'off' },
    blastRadius: '写入类请求全部失败，读请求不受影响',
    riskLevel: 'critical',
  },
  {
    title: '扩容数据库连接池',
    target: () => 'primary-db',
    parameters: { maxConnections: '200' },
    blastRadius: '数据库连接数上限提高，影响共享该实例的服务',
    riskLevel: 'high',
  },
  {
    title: '静默关联告警',
    target: () => 'alertmanager',
    parameters: { duration: '30m', scope: '本事故关联规则' },
    blastRadius: '仅抑制通知，不改变监控判定',
    riskLevel: 'low',
  },
]

function buildEvidence(rnd: () => number, incidentId: string, service: string, at: string): Evidence[] {
  const count = intBetween(rnd, 2, 4)
  const items: Evidence[] = []
  for (let i = 0; i < count; i += 1) {
    const kind = pick(rnd, EVIDENCE_KINDS)
    items.push({
      id: `${incidentId}-EV-${i + 1}`,
      kind,
      summary:
        kind === 'metric'
          ? `${service} P99 延迟在 ${i + 1} 分钟内上升 ${intBetween(rnd, 20, 240)}%`
          : kind === 'log'
            ? `${service} 出现 ${intBetween(rnd, 12, 320)} 条超时日志`
            : kind === 'change'
              ? `发布窗口内有一次配置推送（修订 ${intBetween(rnd, 100, 999)}）`
              : `上游依赖中有 ${intBetween(rnd, 1, 3)} 个服务处于降级状态`,
      sourceRef:
        kind === 'metric'
          ? `prometheus/${service}.latency.p99`
          : kind === 'log'
            ? `loki/${service}`
            : kind === 'change'
              ? `change-feed/${service}`
              : `topology/${service}`,
      at,
    })
  }
  return items
}

function buildFindings(rnd: () => number, incidentId: string, evidence: readonly Evidence[]): Finding[] {
  const count = intBetween(rnd, 1, 2)
  const findings: Finding[] = []
  for (let i = 0; i < count; i += 1) {
    findings.push({
      id: `${incidentId}-F-${i + 1}`,
      statement: pick(rnd, FINDING_TEMPLATES),
      confidence: pickWeighted(rnd, [
        ['medium', 4],
        ['high', 3],
        ['low', 2],
      ] as const),
      evidenceIds: evidence.slice(0, Math.max(1, evidence.length - i)).map((item) => item.id),
    })
  }
  return findings
}

function buildActions(
  rnd: () => number,
  incidentId: string,
  service: string,
  runId: string | undefined,
): ProposedAction[] {
  const count = intBetween(rnd, 1, 3)
  const chosen = new Set<number>()
  const actions: ProposedAction[] = []
  while (actions.length < count) {
    const index = intBetween(rnd, 0, ACTION_TEMPLATES.length - 1)
    if (chosen.has(index)) continue
    chosen.add(index)
    const template = ACTION_TEMPLATES[index]
    if (!template) continue
    actions.push({
      id: `${incidentId}-A-${actions.length + 1}`,
      incidentId,
      runId,
      title: template.title,
      target: template.target(service),
      parameters: template.parameters,
      blastRadius: template.blastRadius,
      riskLevel: template.riskLevel,
      approvalId:
        template.riskLevel === 'high' || template.riskLevel === 'critical'
          ? `${incidentId}-A-${actions.length + 1}-APR`
          : undefined,
      execution: 'awaiting-integration',
    })
  }
  return actions
}

function buildTimeline(
  rnd: () => number,
  incidentId: string,
  service: string,
  severity: Severity,
  detectedAt: string,
  moduleId: string | undefined,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    {
      id: `${incidentId}-T-1`,
      at: detectedAt,
      kind: 'detected',
      actor: '监控',
      summary: `检测到 ${service} 异常，判定为 ${severity}`,
    },
    {
      id: `${incidentId}-T-2`,
      at: addMinutes(detectedAt, 1),
      kind: 'alert',
      actor: '告警系统',
      summary: `${service} 触发关联告警 ${intBetween(rnd, 1, 4)} 条`,
    },
  ]

  if (moduleId) {
    entries.push({
      id: `${incidentId}-T-3`,
      at: addMinutes(detectedAt, 2),
      kind: 'decision',
      actor: moduleId,
      summary: 'Agent 开始分析，先读取指标与最近变更记录',
    })
  }

  const extra = intBetween(rnd, 1, 4)
  for (let i = 0; i < extra; i += 1) {
    const kind = pick(rnd, ['tool-call', 'decision', 'note'] as const)
    entries.push({
      id: `${incidentId}-T-${entries.length + 1}`,
      at: addMinutes(detectedAt, 3 + i * intBetween(rnd, 1, 4)),
      kind,
      actor: kind === 'tool-call' ? '工具流水线' : '值班工程师',
      summary:
        kind === 'tool-call'
          ? `调用 ${pick(rnd, TOOL_NAMES)} 完成一次只读查询`
          : kind === 'decision'
            ? '形成初步判断，已关联证据'
            : '人工补充观察：错误集中在部分实例',
    })
  }

  return entries
}

export function createMockDataset(): MockDataset {
  const rnd = createRandom(DATASET_SEED)

  // 事故：20 条。严重等级与状态的分布是显式给定的，再确定性洗牌，
  // 这样每一档枚举都必然出现——演示数据不能靠随机抽样碰运气覆盖枚举。
  const INCIDENT_COUNT = 20
  const severityPlan = shuffle(rnd, [
    ...Array<Severity>(3).fill('sev1'),
    ...Array<Severity>(6).fill('sev2'),
    ...Array<Severity>(7).fill('sev3'),
    ...Array<Severity>(4).fill('sev4'),
  ])
  const statusPlan = shuffle(rnd, [
    ...Array<IncidentStatus>(6).fill('open'),
    ...Array<IncidentStatus>(5).fill('analyzing'),
    ...Array<IncidentStatus>(3).fill('awaiting-approval'),
    ...Array<IncidentStatus>(3).fill('mitigating'),
    ...Array<IncidentStatus>(2).fill('resolved'),
    ...Array<IncidentStatus>(1).fill('closed'),
  ])

  const incidents: Incident[] = []
  const runs: AgentRun[] = []
  const approvals: ApprovalRequest[] = []
  const audit: AuditRecord[] = []

  // 前五个「会产生进行中运行」的事故各领一个不同的职责模块，
  // 这样五个活跃模块必然各自有一次进行中的运行——不需要事后去改运行状态，
  // 那会让运行状态与事故状态对不上。
  let activeSlot = 0

  for (let index = 0; index < INCIDENT_COUNT; index += 1) {
    const incidentId = `INC-${2100 + index}`
    const service = pick(rnd, SERVICES)
    const severity = severityPlan[index] ?? 'sev3'
    const status = statusPlan[index] ?? 'open'
    const detectedAt = minutesBefore(DATASET_BASE_TIME, 12 + index * 37)
    const hasRun = status !== 'open' || rnd() > 0.5
    const moduleId = hasRun
      ? isActiveIncidentStatus(status)
        ? activeModuleAt(activeSlot++)
        : activeModuleAt(index)
      : undefined
    const runId = hasRun ? `RUN-${1400 + index}` : undefined

    const evidence = buildEvidence(rnd, incidentId, service, detectedAt)
    const findings = buildFindings(rnd, incidentId, evidence)
    const actions = buildActions(rnd, incidentId, service, runId)
    const timeline = buildTimeline(rnd, incidentId, service, severity, detectedAt, moduleId)

    const metrics: MetricSummary[] = [
      {
        label: 'P99 延迟',
        value: String(intBetween(rnd, 320, 4200)),
        unit: 'ms',
        trend: pick(rnd, ['rising', 'steady', 'falling'] as const),
      },
      {
        label: '错误率',
        value: (intBetween(rnd, 5, 480) / 100).toFixed(2),
        unit: '%',
        trend: 'rising',
      },
      {
        label: '受影响请求',
        value: String(intBetween(rnd, 120, 98_000)),
        unit: '次',
        trend: 'rising',
      },
    ]

    const executionResults: ExecutionResult[] = actions
      .filter((action) => action.riskLevel !== 'critical')
      .slice(0, 1)
      .map((action, i) => ({
        id: `${incidentId}-X-${i + 1}`,
        actionId: action.id,
        at: addMinutes(detectedAt, intBetween(rnd, 6, 30)),
        // 演示环境未接入真实执行，执行结果只登记到「待接入」，不出现已成功的表述。
        status: 'awaiting-integration' as const,
        summary: '已形成处置结论，等待接入真实执行通道',
      }))

    incidents.push({
      id: incidentId,
      title: pick(rnd, INCIDENT_TITLES),
      severity,
      status,
      source: pick(rnd, SOURCES),
      service,
      detectedAt,
      updatedAt: addMinutes(detectedAt, intBetween(rnd, 3, 40)),
      owner: pick(rnd, OWNERS),
      runId,
      timeline,
      metrics,
      evidence,
      findings,
      actions,
      executionResults,
    })

    for (const result of executionResults) {
      audit.push({
        id: `${result.id}-AUD`,
        at: result.at,
        kind: 'execution',
        actor: '执行流水线',
        subject: result.actionId,
        summary: result.summary,
        detail: '演示环境未接入真实执行通道，此处只登记处置结论',
        traceId: `trace-${incidentId}`,
      })
    }

    audit.push({
      id: `${incidentId}-AUD-1`,
      at: detectedAt,
      kind: 'event',
      actor: '监控',
      subject: incidentId,
      summary: `事故创建：${service} ${severity}`,
      detail: `来源 ${pick(rnd, SOURCES)}，受影响服务 ${service}`,
      traceId: `trace-${incidentId}`,
    })

    // 运行：只有部分事故有 Agent 运行。
    if (hasRun && runId && moduleId) {
      const runStatus: RunStatus =
        status === 'awaiting-approval'
          ? 'waiting-approval'
          : status === 'resolved' || status === 'closed'
            ? 'succeeded'
            : status === 'open'
              ? 'queued'
              : 'running'

      const turnCount = intBetween(rnd, 1, 3)
      const turns: Turn[] = []
      for (let t = 0; t < turnCount; t += 1) {
        const stepCount = intBetween(rnd, 1, 3)
        const steps: Step[] = []
        for (let s = 0; s < stepCount; s += 1) {
          const toolCalls: ToolCall[] = []
          const toolCount = intBetween(rnd, 0, 2)
          for (let c = 0; c < toolCount; c += 1) {
            toolCalls.push({
              id: `${runId}-T${t + 1}-S${s + 1}-C${c + 1}`,
              name: pick(rnd, TOOL_NAMES),
              at: addMinutes(detectedAt, 3 + t * 5 + s * 2 + c),
              phase: 'execute',
              decision: 'allow',
              durationMs: intBetween(rnd, 40, 2400),
              summary: '只读查询，无副作用',
            })
          }
          steps.push({
            id: `${runId}-T${t + 1}-S${s + 1}`,
            index: s + 1,
            title: pick(rnd, ['收集症状指标', '核对最近变更', '对比上下游调用链', '汇总证据'] as const),
            at: addMinutes(detectedAt, 3 + t * 5 + s * 2),
            toolCalls,
            modelRequests: [
              {
                id: `${runId}-T${t + 1}-S${s + 1}-M`,
                at: addMinutes(detectedAt, 3 + t * 5 + s * 2),
                model: 'demo-model',
                summary: '根据已收集证据形成阶段性判断',
                promptTokens: intBetween(rnd, 800, 5200),
                completionTokens: intBetween(rnd, 120, 900),
              },
            ],
          })
        }
        turns.push({
          id: `${runId}-T${t + 1}`,
          index: t + 1,
          startedAt: addMinutes(detectedAt, 3 + t * 5),
          endedAt: addMinutes(detectedAt, 6 + t * 5),
          endReason: 'completed',
          steps,
        })
      }

      const waitingReason =
        runStatus === 'waiting-approval'
          ? `等待安全审查批准：${actions[0]?.title ?? '处置动作'}（风险 ${actions[0]?.riskLevel ?? 'high'}）`
          : undefined

      runs.push({
        id: runId,
        incidentId,
        moduleId,
        status: runStatus,
        startedAt: addMinutes(detectedAt, 2),
        endedAt: runStatus === 'succeeded' ? addMinutes(detectedAt, 25) : undefined,
        waitingReason,
        turns,
      })

      audit.push({
        id: `${incidentId}-AUD-2`,
        at: addMinutes(detectedAt, 2),
        kind: 'decision',
        actor: moduleId,
        subject: runId,
        summary: `Agent 运行启动（${moduleId}）`,
        detail: `共 ${turnCount} 个轮次`,
        traceId: `trace-${runId}`,
      })

      for (const turn of turns) {
        for (const step of turn.steps) {
          for (const call of step.toolCalls) {
            audit.push({
              id: `${call.id}-AUD`,
              at: call.at,
              kind: 'tool-call',
              actor: moduleId,
              subject: call.name,
              summary: `工具调用 ${call.name}`,
              detail: call.summary,
              traceId: `trace-${runId}`,
            })
          }
        }
      }
    }

    // 审批：高风险与致命动作各生成一条，覆盖四种队列状态。
    for (const action of actions) {
      if (!action.approvalId) continue
      const status4: ApprovalStatus = pickWeighted(rnd, [
        ['pending', 6],
        ['approved', 2],
        ['rejected', 2],
        ['expired', 1],
      ] as const)
      const outcome: ApprovalOutcome | undefined =
        status4 === 'approved'
          ? 'allowed-once'
          : status4 === 'rejected'
            ? 'rejected'
            : status4 === 'expired'
              ? 'cancelled'
              : undefined
      const requestedAt = addMinutes(detectedAt, 4)
      approvals.push({
        id: action.approvalId,
        actionId: action.id,
        actionTitle: action.title,
        status: status4,
        outcome,
        policy: 'ask',
        riskLevel: action.riskLevel,
        target: action.target,
        parameters: action.parameters,
        blastRadius: action.blastRadius,
        requestedBy: moduleId ?? 'incident-command',
        requestedAt,
        expiresAt: addMinutes(requestedAt, 30),
        decidedBy: status4 === 'pending' ? undefined : pick(rnd, OWNERS),
        decidedAt: status4 === 'pending' ? undefined : addMinutes(requestedAt, intBetween(rnd, 2, 20)),
        note: status4 === 'rejected' ? '影响范围过大，改走灰度通道' : undefined,
      })

      audit.push({
        id: `${action.approvalId}-AUD`,
        at: requestedAt,
        kind: 'approval',
        actor: moduleId ?? 'incident-command',
        subject: action.approvalId,
        summary: `提交审批：${action.title}`,
        detail: `风险 ${action.riskLevel}，影响范围：${action.blastRadius}`,
        traceId: `trace-${incidentId}`,
      })
    }
  }

  // 告警：与事故并存的原始信号。
  const alerts: Alert[] = []
  for (let index = 0; index < 18; index += 1) {
    const service = pick(rnd, SERVICES)
    const linkedIncident = rnd() > 0.4 ? incidents[intBetween(rnd, 0, incidents.length - 1)] : undefined
    alerts.push({
      id: `ALT-${3100 + index}`,
      incidentId: linkedIncident?.id,
      severity: pickWeighted(rnd, [
        ['sev3', 5],
        ['sev2', 4],
        ['sev4', 4],
        ['sev1', 1],
      ] as const),
      source: pick(rnd, SOURCES),
      service,
      at: minutesBefore(DATASET_BASE_TIME, 5 + index * 23),
      summary: `${service}：${pick(rnd, ALERT_SUMMARIES)}`,
    })
  }

  // 待处理任务：尚未归属到事故，但仍需人处置。
  const pendingTasks: PendingTask[] = PENDING_TASKS.map((title, index) => ({
    id: `TASK-${4100 + index}`,
    title,
    source: pick(rnd, SOURCES),
    service: pick(rnd, SERVICES),
    at: minutesBefore(DATASET_BASE_TIME, 30 + index * 95),
    owner: rnd() > 0.5 ? pick(rnd, OWNERS) : undefined,
  }))

  // 技能：来自技能目录，含启用与停用两种状态。
  const skills: Skill[] = SKILL_SEEDS.map((seed) => ({
    ...seed,
    lastUsedAt: minutesBefore(DATASET_BASE_TIME, intBetween(rnd, 10, 2880)),
  }))

  // 一次失败的运行：错误信息与轮次结束原因是验收内容，
  // 必须能从演示数据里看到，而不是只能靠测试里手写的替身。
  const failedHost = incidents.find((incident) => incident.runId === undefined)
  if (failedHost) {
    const failedRunId = 'RUN-1900'
    const failedModuleId = IDLE_MODULE_IDS[0]
    const failedAt = addMinutes(failedHost.detectedAt, 2)
    const failedEndedAt = addMinutes(failedAt, 7)
    failedHost.runId = failedRunId
    runs.push({
      id: failedRunId,
      incidentId: failedHost.id,
      moduleId: failedModuleId,
      status: 'failed',
      startedAt: failedAt,
      endedAt: failedEndedAt,
      error: { message: '只读查询超时：工具在超时窗口内未返回', endReason: 'error' },
      turns: [
        {
          id: `${failedRunId}-T1`,
          index: 1,
          startedAt: failedAt,
          endedAt: failedEndedAt,
          endReason: 'error',
          steps: [
            {
              id: `${failedRunId}-T1-S1`,
              index: 1,
              title: '收集症状指标',
              at: failedAt,
              modelRequests: [
                {
                  id: `${failedRunId}-T1-S1-M`,
                  at: failedAt,
                  model: 'demo-model',
                  summary: '尝试读取指标并形成初步判断',
                },
              ],
              toolCalls: [
                {
                  id: `${failedRunId}-T1-S1-C1`,
                  name: 'metrics.query',
                  at: failedAt,
                  phase: 'execute',
                  decision: 'allow',
                  durationMs: 7000,
                  summary: '只读查询超时，未返回结果',
                },
              ],
            },
          ],
        },
      ],
    })
    failedHost.timeline = [
      ...failedHost.timeline,
      {
        id: `${failedHost.id}-T-fail`,
        at: failedEndedAt,
        kind: 'note',
        actor: failedModuleId,
        summary: 'Agent 运行失败：只读查询超时，已停止分析并等待人工接管',
      },
    ]
  }

  // 职责模块状态由运行推导：有进行中或等待审批的运行才算活跃。
  const moduleStatuses: ModuleStatus[] = [
    ...ACTIVE_MODULE_IDS.map((moduleId) => {
      const activeRun = runs.find(
        (run) =>
          run.moduleId === moduleId &&
          (run.status === 'running' || run.status === 'waiting-approval'),
      )
      return {
        moduleId,
        status: activeRun ? ('running' as const) : ('idle' as const),
        activeRunId: activeRun?.id,
        incidentId: activeRun?.incidentId,
      }
    }),
    ...IDLE_MODULE_IDS.map((moduleId) => ({ moduleId, status: 'idle' as const })),
  ]

  audit.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

  return {
    incidents,
    alerts,
    pendingTasks,
    runs,
    approvals,
    skills,
    audit,
    moduleStatuses,
  }
}

/** 事故、告警与待处理任务合并成事件中心的列表行。 */
export function toIncidentListRows(dataset: MockDataset): IncidentListRow[] {
  const rows: IncidentListRow[] = []

  for (const incident of dataset.incidents) {
    const run = incident.runId
      ? dataset.runs.find((candidate) => candidate.id === incident.runId)
      : undefined
    rows.push({
      id: incident.id,
      kind: 'incident',
      title: incident.title,
      severity: incident.severity,
      status: incident.status,
      source: incident.source,
      service: incident.service,
      at: incident.detectedAt,
      owner: incident.owner,
      moduleId: run?.moduleId,
    })
  }

  for (const alert of dataset.alerts) {
    rows.push({
      id: alert.id,
      kind: 'alert',
      title: alert.summary,
      severity: alert.severity,
      source: alert.source,
      service: alert.service,
      at: alert.at,
    })
  }

  for (const task of dataset.pendingTasks) {
    rows.push({
      id: task.id,
      kind: 'pending-task',
      title: task.title,
      // 待处理任务没有严重度，列表统一按最低档呈现，避免看起来比事故更紧急。
      severity: 'sev4',
      source: task.source,
      service: task.service,
      at: task.at,
      owner: task.owner,
    })
  }

  return rows
}
