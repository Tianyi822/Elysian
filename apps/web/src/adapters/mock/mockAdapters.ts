import type {
  AgentRun,
  ApprovalOutcome,
  ApprovalRequest,
  AuditRecord,
  Container,
  ContainerAction,
  ContainerCreateInput,
  ContainerImage,
  DatabaseInstance,
  ElysianEvent,
  EventStreamHandlers,
  Incident,
  IncidentListRow,
  ModuleStatus,
  Skill,
  Unsubscribe,
} from '@elysian/contracts'
import { SEVERITY_RANK } from '@elysian/contracts'
import type {
  ApprovalAdapter,
  AuditAdapter,
  ContainerAdapter,
  DatabaseAdapter,
  DatabaseCreateInput,
  EventsAdapter,
  IncidentAdapter,
  IncidentListQuery,
  IncidentListResult,
  MockQueryResult,
  RunAdapter,
  SessionAdapter,
  SkillAdapter,
} from '../../contracts/adapters'
import { DATABASE_INSTANCES, addDatabaseInstance, removeDatabaseInstance } from './databaseData'
import { runMockQuery } from './databaseQuery'
import { execContainerCommand } from './containerTerminal'
import { CONTAINERS, CONTAINER_IMAGES, mockImageArtifact } from './containersData'
import { autoContainerName } from './containersData'
import {
  INITIAL_DISKS,
  INITIAL_LOAD,
  nextDisksWalk,
  nextLoadWalk,
} from './resourceMetrics'
import { toIncidentListRows } from './dataset'
import type { MockDataset } from './dataset'

/*
 * 各个领域的 mock 适配实现。它们共用同一份内存数据集，
 * 因此审批、审计、事件流之间引用的标识是一致的。
 */

function matches(selected: readonly string[] | undefined, value: string | undefined): boolean {
  if (!selected || selected.length === 0) return true
  if (value === undefined) return false
  return selected.includes(value)
}

export function sortRows(
  rows: readonly IncidentListRow[],
  sort: IncidentListQuery['sort'],
): IncidentListRow[] {
  const sorted = [...rows]
  switch (sort) {
    case 'detected-asc':
      return sorted.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    case 'severity':
      return sorted.sort((a, b) => {
        const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
        if (bySeverity !== 0) return bySeverity
        return a.at < b.at ? 1 : a.at > b.at ? -1 : 0
      })
    case 'detected-desc':
    default:
      return sorted.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }
}

export class MockIncidentAdapter implements IncidentAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async listRows(query: IncidentListQuery): Promise<IncidentListResult> {
    const rows = toIncidentListRows(this.dataset())
    const filtered = rows.filter(
      (row) =>
        matches(query.severities, row.severity) &&
        matches(query.statuses, row.status) &&
        matches(query.sources, row.source),
    )
    const availableSources = [...new Set(rows.map((row) => row.source))].sort()
    return {
      rows: sortRows(filtered, query.sort),
      total: filtered.length,
      availableSources,
    }
  }

  async find(incidentId: string): Promise<Incident | undefined> {
    return this.dataset().incidents.find((incident) => incident.id === incidentId)
  }
}

export class MockSkillAdapter implements SkillAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async list(): Promise<readonly Skill[]> {
    return this.dataset().skills
  }

  async setEnabled(skillId: string, enabled: boolean): Promise<Skill> {
    const dataset = this.dataset()
    const index = dataset.skills.findIndex((candidate) => candidate.id === skillId)
    const current = index >= 0 ? dataset.skills[index] : undefined
    if (!current) throw new Error(`技能不存在：${skillId}`)
    const updated: Skill = { ...current, enabled }
    dataset.skills[index] = updated
    return updated
  }
}

export class MockApprovalAdapter implements ApprovalAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async list(): Promise<readonly ApprovalRequest[]> {
    return this.dataset().approvals
  }

  async decide(
    requestId: string,
    decision: { outcome: ApprovalOutcome; note?: string },
  ): Promise<ApprovalRequest> {
    const dataset = this.dataset()
    const index = dataset.approvals.findIndex((candidate) => candidate.id === requestId)
    const current = index >= 0 ? dataset.approvals[index] : undefined
    if (!current) throw new Error(`审批请求不存在：${requestId}`)

    const decidedAt = new Date().toISOString()
    const updated: ApprovalRequest = {
      ...current,
      status: decision.outcome === 'rejected' ? 'rejected' : 'approved',
      outcome: decision.outcome,
      decidedBy: '当前用户',
      decidedAt,
      note: decision.note,
    }
    dataset.approvals[index] = updated

    // 审批决定必须留下审计痕迹：审计日志页刷新后就能看到这一条。
    const decisionLabel = decision.outcome === 'rejected' ? '已拒绝' : '已批准'
    dataset.audit.unshift({
      id: `${requestId}-DECISION`,
      at: decidedAt,
      kind: 'approval',
      actor: '当前用户',
      subject: current.target,
      summary: `审批决定：${decisionLabel} · ${current.actionTitle}`,
      detail: `风险 ${current.riskLevel}；影响范围：${current.blastRadius}；决策结果 ${decision.outcome}`,
      traceId: `approval-${requestId}`,
    })
    // 审计列表约定按时间倒序，插入后重排，避免时钟与种子基准时间不一致时顺序错乱。
    dataset.audit.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

    return updated
  }
}

export class MockAuditAdapter implements AuditAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async list(): Promise<readonly AuditRecord[]> {
    return this.dataset().audit
  }
}

/**
 * 会话与权限的 mock 实现：演示环境全部放行。
 * 让「无权限」分支真实存在但默认不触发——接入认证后换成真实实现即可，界面不用改。
 */
export class MockSessionAdapter implements SessionAdapter {
  async canView(): Promise<boolean> {
    return true
  }
}

export class MockRunAdapter implements RunAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async list(): Promise<readonly AgentRun[]> {
    return this.dataset().runs
  }

  async find(runId: string): Promise<AgentRun | undefined> {
    return this.dataset().runs.find((run) => run.id === runId)
  }

  async listModuleStatuses(): Promise<readonly ModuleStatus[]> {
    return this.dataset().moduleStatuses
  }
}

export class MockContainerAdapter implements ContainerAdapter {
  constructor(
    private readonly dataset: () => MockDataset,
    private readonly hooks: {
      onAction: (containerId: string) => void
      scheduleRestart: (containerId: string) => void
      onCreate: (containerId: string) => void
    },
  ) {}

  async list(): Promise<readonly Container[]> {
    return [...this.dataset().containers]
  }

  async listImages(): Promise<readonly ContainerImage[]> {
    return [...this.dataset().images]
  }

  async execMockCommand(
    containerId: string,
    command: string,
  ): Promise<{ lines: readonly string[]; clear?: boolean }> {
    const container = this.dataset().containers.find((c) => c.id === containerId)
    if (!container) throw new Error('容器不存在，无法执行演示终端命令')
    const image = this.dataset().images.find((i) => i.id === container.imageId)
    if (!image) throw new Error('容器所用镜像不存在，无法执行演示终端命令')
    return execContainerCommand(container, image, command)
  }

  async requestAction(containerId: string, action: ContainerAction): Promise<Container> {
    const container = this.dataset().containers.find((c) => c.id === containerId)
    if (!container) throw new Error('容器不存在，操作失败')
    if (action === 'start') {
      container.status = 'running'
      container.startedAt = new Date().toISOString()
    } else if (action === 'stop') {
      container.status = 'stopped'
      container.startedAt = undefined
    } else {
      container.status = 'restarting'
      this.hooks.scheduleRestart(containerId)
    }
    this.hooks.onAction(containerId)
    return { ...container }
  }

  async create(input: ContainerCreateInput): Promise<Container> {
    const dataset = this.dataset()
    const image = dataset.images.find((i) => i.id === input.imageId)
    if (!image) throw new Error('镜像不存在，无法创建容器')
    const name = input.name?.trim() || autoContainerName(dataset.containers, image.name)
    if (dataset.containers.some((c) => c.name === name)) {
      throw new Error(`容器名称已存在：${name}`)
    }
    const now = new Date().toISOString()
    const container: Container = {
      id: `ctr-${name}`,
      name,
      status: 'running',
      imageId: input.imageId,
      ports: input.ports.map((p) => ({ ...p })),
      createdAt: now,
      startedAt: now,
      command: input.command?.trim() ?? '',
      env: input.env.map((e) => ({ ...e })),
      volumes: input.volumes.map((v) => ({ ...v })),
      restartPolicy: input.restartPolicy,
    }
    dataset.containers.push(container)
    this.hooks.onCreate(container.id)
    return { ...container }
  }

  async removeImage(imageId: string): Promise<void> {
    const dataset = this.dataset()
    const image = dataset.images.find((i) => i.id === imageId)
    if (!image) throw new Error('镜像不存在，删除失败')
    if (dataset.containers.some((c) => c.imageId === imageId)) {
      throw new Error('镜像仍被容器引用，删除失败')
    }
    dataset.images = dataset.images.filter((i) => i.id !== imageId)
  }

  async pullImage(input: { name: string; tag: string; registry?: string }): Promise<ContainerImage> {
    // registry 只是界面记录的拉取源：mock 不区分来源，全部走同一份确定性数据。
    const dataset = this.dataset()
    if (dataset.images.some((i) => i.name === input.name && i.tag === input.tag)) {
      throw new Error(`镜像已存在：${input.name}:${input.tag}`)
    }
    const { id, digest, sizeMb } = mockImageArtifact(input.name, input.tag)
    const image: ContainerImage = {
      id,
      name: input.name,
      tag: input.tag,
      digest,
      sizeMb,
      pulledAt: new Date().toISOString(),
    }
    dataset.images.push(image)
    return { ...image }
  }
}

export class MockDatabaseAdapter implements DatabaseAdapter {
  async list(): Promise<readonly DatabaseInstance[]> {
    return DATABASE_INSTANCES.map((database) => ({
      ...database,
      credentials: { ...database.credentials },
      storage: { ...database.storage },
      memory: { ...database.memory },
      connections: { ...database.connections },
    }))
  }

  async execMockQuery(databaseId: string, statement: string): Promise<MockQueryResult> {
    const database = DATABASE_INSTANCES.find((item) => item.id === databaseId)
    if (!database) throw new Error(`未找到数据库实例 ${databaseId}`)
    return runMockQuery(database, statement)
  }

  async create(input: DatabaseCreateInput): Promise<DatabaseInstance> {
    if (
      DATABASE_INSTANCES.some((item) => item.engine === input.engine && item.name === input.name)
    ) {
      throw new Error(`数据库 ${input.name} 已存在`)
    }
    const container = CONTAINERS.find((item) => item.id === input.containerId)
    if (!container) throw new Error(`未找到容器 ${input.containerId}`)
    const image = CONTAINER_IMAGES.find((item) => item.id === container.imageId)
    const instance: DatabaseInstance = {
      id: `db-${container.name}-${input.name}`,
      engine: input.engine,
      name: input.name,
      // 版本取承载容器镜像的标签：mariadb:10.11 上的库就是 10.11。
      version: image?.tag ?? '0',
      status: 'running',
      containerId: container.id,
      credentials: { username: input.username, password: input.password },
      storage: { usedGb: 0.1, totalGb: 32 },
      memory: { usedGb: 0.2, totalGb: 4 },
      connections: { active: 1, max: 200 },
      updatedAt: new Date().toISOString(),
    }
    addDatabaseInstance(instance)
    return {
      ...instance,
      credentials: { ...instance.credentials },
      storage: { ...instance.storage },
      memory: { ...instance.memory },
      connections: { ...instance.connections },
    }
  }

  async remove(databaseId: string): Promise<void> {
    const database = DATABASE_INSTANCES.find((item) => item.id === databaseId)
    if (!database) throw new Error(`未找到数据库实例 ${databaseId}`)
    removeDatabaseInstance(databaseId)
  }
}

/**
 * 内存事件源：事件流端点不可用时的降级实现，契约与 SSE 实现完全一致。
 * 它按固定节奏产出确定性的事件内容，使界面在没有服务端进程时也能演示增量刷新。
 */
export function createInMemoryEventsAdapter(
  dataset: () => MockDataset,
  options: { intervalMs?: number } = {},
): EventsAdapter {
  const intervalMs = options.intervalMs ?? 2000

  return {
    subscribe(handlers: EventStreamHandlers): Unsubscribe {
      handlers.onStatus('connecting')

      let counter = 0
      let cursor = 0
      let walk = {
        cpu: 55,
        memory: 68,
        networkIo: 380,
        diskIo: 210,
        load: { ...INITIAL_LOAD },
        disks: INITIAL_DISKS.map((disk) => ({ ...disk })),
      }
      const stepWalk = (): typeof walk => {
        walk = {
          cpu: Math.min(90, Math.max(20, walk.cpu + Math.round((Math.random() - 0.5) * 4))),
          memory: Math.min(92, Math.max(45, walk.memory + Math.round((Math.random() - 0.5) * 2))),
          networkIo: Math.min(950, Math.max(60, walk.networkIo + Math.round((Math.random() - 0.5) * 80))),
          diskIo: Math.min(520, Math.max(40, walk.diskIo + Math.round((Math.random() - 0.5) * 60))),
          load: nextLoadWalk(walk.load),
          disks: nextDisksWalk(walk.disks),
        }
        return walk
      }

      const emitLater = () => {
        counter += 1
        const data = dataset()
        const events: ElysianEvent[] = []

        // 每拍一条资源采样；每 4 拍诞生一次新事故，让图表持续可见地动。
        events.push({
          id: `mem-${counter}-resource`,
          name: 'resource/sample',
          at: new Date().toISOString(),
          payload: stepWalk(),
        })
        if (counter % 4 === 0) {
          const roll = Math.random()
          const severity = roll < 0.1 ? 'sev1' : roll < 0.3 ? 'sev2' : roll < 0.7 ? 'sev3' : 'sev4'
          events.push({
            id: `mem-${counter}-new-incident`,
            name: 'incident/created',
            at: new Date().toISOString(),
            payload: { incidentId: `INC-LIVE-${counter}`, severity },
          })
        }

        const run = data.runs[cursor % Math.max(1, data.runs.length)]
        if (run) {
          events.push({
            id: `mem-${counter}-agent`,
            name: 'agent/status',
            at: new Date().toISOString(),
            payload: {
              moduleId: run.moduleId,
              // 与 mock 事件流端点保持同一套判定，避免同一个事件名在两处语义不同。
              status:
                run.status === 'running' || run.status === 'waiting-approval' ? 'running' : 'idle',
            },
          })
        }

        const approval = data.approvals[cursor % Math.max(1, data.approvals.length)]
        if (approval && approval.status === 'pending') {
          events.push({
            id: `mem-${counter}-approval`,
            name: 'approval/asked',
            at: new Date().toISOString(),
            payload: { approvalId: approval.id },
          })
        }

        const incident = data.incidents[cursor % Math.max(1, data.incidents.length)]
        if (incident) {
          events.push({
            id: `mem-${counter}-incident`,
            name: 'incident/updated',
            at: new Date().toISOString(),
            payload: { incidentId: incident.id, status: incident.status },
          })
        }

        cursor += 1
        for (const event of events) handlers.onEvent(event)
      }

      handlers.onStatus('live')
      const timer = setInterval(emitLater, intervalMs)

      return () => {
        clearInterval(timer)
      }
    },
  }
}
