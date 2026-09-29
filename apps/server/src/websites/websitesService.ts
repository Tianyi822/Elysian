import { randomUUID } from 'node:crypto'
import type {
  PortMapping,
  WebsiteListReport,
  WebsiteProject,
  WebsiteProjectKind,
  WebsiteProxyStatus,
} from '@elysian/contracts'
import {
  PANEL_PORT,
  isValidWebsiteDomain,
  isValidWebsitePort,
  isValidWebsiteProjectName,
  websiteDefaultDeployCommand,
  websiteProjectUsesRuntime,
  websiteRuntimeImageRef,
} from '@elysian/contracts'
import { InvalidRequestError, invalidRequest } from '../shared/errors.ts'
import { SERVER_PORT } from '../shared/ports.ts'
import { buildCaddyConfig, hasForeignConfig, managedHosts, missingHosts, type CaddyManagedSite } from './caddyConfig.ts'
import { CaddyChannelError, caddyChannelStatus, type WebsiteCaddy } from './websitesCaddy.ts'
import type { WebsiteDocker } from './websitesDocker.ts'
import type { WebsiteRecord, WebsiteRegistry } from './websitesRegistry.ts'

/*
 * 网站域编排层：校验（手写中文校验，复用契约纯函数）、查重（名称跨类型全局唯一、
 * 域名唯一、端口三重查重）、容器与站点目录的创建/删除编排、Caddy 配置的推导下发
 * 与漂移呈现。编排顺序与失败路径见规格「动作映射表」与「失败路径」；失败时报
 * 「已做到哪一步、还剩什么」，不伪装完成。
 */

/** 面板与 SSH 保留端口（与容器页 createSpec 同一张表的前三项）。 */
const PANEL_RESERVED_PORTS: readonly number[] = [22, PANEL_PORT, SERVER_PORT]
/** 归宿主 Caddy 的端口：站点流量一律经反向代理进来。 */
const PROXY_RESERVED_PORTS: readonly number[] = [80, 443]
/** 全局创建互斥键：名称与域名的查重都是 check-then-act，串行化全部创建才能关死并发窗口。 */
const CREATE_MUTEX_KEY = 'create'
const NOTE_MAX_LENGTH = 1024

export type WebsiteCreateRequest = {
  kind: WebsiteProjectKind
  name: string
  port: number
  runtimeVersion: string | null
  domain: string | null
  gitUrl: string | null
  note: string | null
}

export type WebsiteUpdateRequest = {
  note?: string | null
  expiryAt?: string | null
}

export type WebsiteService = {
  list(): Promise<WebsiteListReport>
  create(input: WebsiteCreateRequest): Promise<WebsiteProject>
  update(id: string, input: WebsiteUpdateRequest): Promise<WebsiteProject>
  setRunning(id: string, running: boolean): Promise<WebsiteProject>
  logs(id: string): Promise<readonly string[]>
  remove(id: string): Promise<void>
  reconcileProxy(): Promise<WebsiteProxyStatus>
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function trimmed(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw invalidRequest(`${label}无效`)
  const text = value.trim()
  if (text.length > maxLength) throw invalidRequest(`${label}无效`)
  return text === '' ? null : text
}

/** 到期时间判据：YYYY-MM-DD 且是真实存在的日期（清空传 null 或空串，即长期有效）。 */
function normalizeExpiryAt(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalidRequest('到期时间格式无效')
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw invalidRequest('到期时间格式无效')
  }
  return value
}

export function validateWebsiteCreateRequest(input: unknown): WebsiteCreateRequest {
  const row = object(input)
  const kind = row.kind
  if (kind !== 'java' && kind !== 'node' && kind !== 'go' && kind !== 'python' && kind !== 'html') {
    throw invalidRequest('项目类型无效')
  }
  if (typeof row.name !== 'string' || !isValidWebsiteProjectName(row.name)) {
    throw invalidRequest('项目名称需为 1-64 个字符，且不能包含路径分隔符或控制字符')
  }
  if (typeof row.port !== 'number' || !isValidWebsitePort(row.port)) {
    throw invalidRequest('端口需为 1-65535 的整数')
  }
  let runtimeVersion: string | null = null
  if (websiteProjectUsesRuntime(kind)) {
    if (typeof row.runtimeVersion !== 'string' || row.runtimeVersion.trim() === '') {
      throw invalidRequest('请选择运行时版本')
    }
    if (websiteRuntimeImageRef(kind, row.runtimeVersion) === null) {
      throw invalidRequest('运行时版本不在可选目录内')
    }
    runtimeVersion = row.runtimeVersion
  }
  let domain: string | null = null
  if (row.domain !== undefined && row.domain !== null && row.domain !== '') {
    if (typeof row.domain !== 'string' || !isValidWebsiteDomain(row.domain)) throw invalidRequest('域名无效')
    // DNS 与 Caddy 的 host 匹配都大小写不敏感：登记统一归一小写，大小写变体在
    // 查重与路由生成里都是同一域名，不会生成同 host 双路由互相遮蔽。
    domain = row.domain.trim().toLowerCase()
  }
  return {
    kind,
    name: row.name.trim(),
    port: row.port,
    runtimeVersion,
    domain,
    gitUrl: trimmed(row.gitUrl, 'Git 地址', 2048),
    note: trimmed(row.note, '备注', 1024),
  }
}

export function validateWebsiteUpdateRequest(input: unknown): WebsiteUpdateRequest {
  const row = object(input)
  const request: WebsiteUpdateRequest = {}
  if (row.note !== undefined) {
    // 与创建路径同一上限（trimmed 内含长度校验）：登记读侧有 1 MiB 上限，无界的
    // 备注可把登记撑破到 list/remove 全体失败且面板内无法恢复。
    request.note = trimmed(row.note, '备注', NOTE_MAX_LENGTH)
  }
  if (row.expiryAt !== undefined) {
    request.expiryAt = normalizeExpiryAt(row.expiryAt)
  }
  return request
}

function effectiveHostIp(hostIp?: string): string {
  return hostIp === undefined || hostIp === '' ? '127.0.0.1' : hostIp
}

function hostIpsOverlap(a: string, b: string): boolean {
  return a === b || a === '0.0.0.0' || b === '0.0.0.0'
}

/** 期望路由投影：有域名的容器站 reverse_proxy、开着的 HTML 域名站 file_server。 */
function expectedProxy(rows: readonly WebsiteRecord[]): { sites: readonly CaddyManagedSite[]; hosts: Set<string> } {
  const sites: CaddyManagedSite[] = []
  const hosts = new Set<string>()
  for (const row of rows) {
    if (row.domain === null) continue
    if (row.kind === 'html' && !row.enabled) continue
    sites.push(row.kind === 'html'
      ? { kind: 'static', domain: row.domain, root: row.rootDir }
      : { kind: 'proxy', domain: row.domain, port: row.port })
    hosts.add(row.domain)
  }
  return { sites, hosts }
}

export function createWebsiteService(deps: {
  registry: WebsiteRegistry
  docker: WebsiteDocker
  caddy: WebsiteCaddy
  mountRoot: string
  listPortBindings(): Promise<readonly PortMapping[]>
  selfContainerId?: string
}): WebsiteService {
  const { registry, docker, caddy } = deps
  const inProgress = new Set<string>()

  async function record(id: string): Promise<WebsiteRecord> {
    const found = (await registry.list()).find((row) => row.id === id)
    if (!found) throw new InvalidRequestError(404, `未找到项目 ${id}`)
    return found
  }

  async function currentHosts(): Promise<Set<string> | null> {
    try {
      return managedHosts(await caddy.currentConfig())
    } catch {
      return null
    }
  }

  async function projectRow(row: WebsiteRecord, hosts: ReadonlySet<string> | null): Promise<WebsiteProject> {
    let running = false
    let pid: number | null = null
    if (row.kind !== 'html') {
      if (row.containerId) {
        try {
          const state = object(object(await docker.inspect(row.containerId)).State)
          running = state.Running === true
          const statePid = state.Pid
          pid = typeof statePid === 'number' && statePid > 0 ? statePid : null
        } catch (error) {
          if (!(error instanceof InvalidRequestError) || error.status !== 404) throw error
          // 容器已被容器页或外部 docker rm 删除：折算为已停止、pid=null，
          // containerId 保留登记值如实显示，不隐藏也不伪报运行。
        }
      }
    } else {
      running = row.enabled
    }
    return {
      id: row.id, kind: row.kind, name: row.name, pid,
      containerId: row.containerId, port: row.port,
      runtimeVersion: row.runtimeVersion, rootDir: row.rootDir,
      runState: running ? 'running' : 'stopped',
      domain: row.domain, expiryAt: row.expiryAt, note: row.note,
      cert: row.domain !== null && hosts !== null && hosts.has(row.domain) ? 'deployed' : 'none',
      category: row.category, deployCommand: row.deployCommand, gitUrl: row.gitUrl,
      traffic: { todayMb: 0, totalGb: 0 },
    }
  }

  /** 下发结果：成功给出期望 host 集合（供 cert 折算）；通道不可用给出中文原因（如实返回、不报成功）。 */
  type CaddyPushResult = { applied: true; hosts: Set<string> } | { applied: false; detail: string | null }

  /**
   * 下发核心（站点变更与对账共用一份编排）：读当前配置 → 外部配置防护 → POST /load
   * 整配置原子替换。通道不可用按结果返回（调用方决定跳过还是呈现）；存在面板外
   * 配置（409）或下发被拒时抛中文错误。
   */
  async function pushCaddyConfig(rows: readonly WebsiteRecord[]): Promise<CaddyPushResult> {
    const { sites, hosts } = expectedProxy(rows)
    const config = buildCaddyConfig(sites, { adminListen: caddy.adminListen })
    let current: unknown
    try {
      current = await caddy.currentConfig()
    } catch (error) {
      if (error instanceof CaddyChannelError) return { applied: false, detail: caddyChannelStatus(error).detail }
      throw error
    }
    if (hasForeignConfig(current, hosts, { adminListen: caddy.adminListen })) {
      throw new InvalidRequestError(409, '宿主 Caddy 存在面板外的配置，拒绝覆盖')
    }
    try {
      await caddy.load(config)
    } catch (error) {
      if (error instanceof CaddyChannelError) {
        throw new Error(`反向代理配置下发被拒绝：${error.message}`)
      }
      throw error
    }
    return { applied: true, hosts }
  }

  /**
   * 下发队列：同进程内的全部下发串行执行，且每次都从 registry **重新读取**再推导
   * （mutate 可先施加排除或忽略——删除在移除登记前回收路由时排除自身）。没有它，
   * 两个并发站点写各自拿着旧快照整配置替换，后发会把先发刚下发的路由回滚掉。
   */
  let pushTail: Promise<unknown> = Promise.resolve()
  function queueCaddyPush(
    mutate?: (rows: readonly WebsiteRecord[]) => readonly WebsiteRecord[],
  ): Promise<CaddyPushResult> {
    const run = pushTail.then(async () => {
      const rows = await registry.list()
      return pushCaddyConfig(mutate ? mutate(rows) : rows)
    })
    pushTail = run.catch(() => undefined)
    return run
  }

  /** 端口三重查重：保留端口 → 现有容器绑定（含 0.0.0.0 重叠）→ registry 已登记站点。 */
  async function assertPortAvailable(port: number, rows: readonly WebsiteRecord[]): Promise<void> {
    if (PANEL_RESERVED_PORTS.includes(port)) throw invalidRequest(`宿主端口为面板保留：${port}`)
    if (PROXY_RESERVED_PORTS.includes(port)) throw invalidRequest(`宿主端口由反向代理保留：${port}`)
    const bindings = await deps.listPortBindings()
    const clash = bindings.some((binding) =>
      binding.protocol !== 'udp' &&
      binding.hostPort === port &&
      hostIpsOverlap('127.0.0.1', effectiveHostIp(binding.hostIp)))
    if (clash) throw new InvalidRequestError(409, `宿主端口已被占用：${port}/tcp`)
    if (rows.some((row) => row.port === port)) throw new InvalidRequestError(409, `宿主端口已被站点占用：${port}`)
  }

  async function list(): Promise<WebsiteListReport> {
    const rows = await registry.list()
    const { hosts: expectedHosts } = expectedProxy(rows)
    let hosts: Set<string> | null
    let proxy: WebsiteProxyStatus
    try {
      hosts = managedHosts(await caddy.currentConfig())
      const missing = [...expectedHosts].filter((host) => !hosts!.has(host))
      proxy = missing.length > 0
        ? { state: 'active', detail: `${missing.length} 个站点的路由未下发` }
        : { state: 'active', detail: null }
    } catch (error) {
      hosts = null
      proxy = caddyChannelStatus(error)
    }
    return { projects: await Promise.all(rows.map((row) => projectRow(row, hosts))), proxy }
  }

  async function create(input: WebsiteCreateRequest): Promise<WebsiteProject> {
    // 全局串行化全部创建：名称（跨类型全局唯一）与域名的查重都是跨 await 的
    // check-then-act，按 kind+name 分键会让并发同名/同域创建双双通过查重。
    if (inProgress.has(CREATE_MUTEX_KEY)) throw new InvalidRequestError(409, '网站项目正在创建，请稍后再试')
    inProgress.add(CREATE_MUTEX_KEY)
    try {
      const rows = await registry.list()
      if (rows.some((row) => row.name === input.name)) {
        throw new InvalidRequestError(409, `项目已存在：${input.name}`)
      }
      if (input.domain !== null && rows.some((row) => row.domain === input.domain)) {
        throw new InvalidRequestError(409, `域名已被绑定：${input.domain}`)
      }
      await assertPortAvailable(input.port, rows)

      // 目录与镜像先于容器：镜像缺失不建容器；目录建后失败保留（空目录无害）。
      const projectId = randomUUID()
      const rootDir = await docker.ensureSiteDir(input.name, deps.mountRoot)
      const imageRef = input.kind === 'html' ? null : websiteRuntimeImageRef(input.kind, input.runtimeVersion)
      let containerId: string | null = null
      let containerName: string | null = null
      if (input.kind !== 'html' && imageRef !== null) {
        await docker.ensureImage(imageRef)
        containerName = docker.newContainerName()
        const created = await docker.create({
          imageRef, kind: input.kind, version: input.runtimeVersion as string,
          projectId, port: input.port, bindSource: rootDir, containerName,
        })
        containerId = created.containerId
        try {
          await docker.start(containerId)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          let message = `创建站点容器失败：容器启动失败，已撤销创建：${reason}`
          try {
            await docker.removeCreated(containerId)
          } catch {
            message += `且撤销失败，容器 ID 为 ${containerId}`
          }
          throw new Error(message)
        }
        // 新建即已停止（对齐 mock 基准：新建卡片呈已停止、pid=null；容器与目录已就位）。
        try {
          await docker.stop(containerId)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          throw new Error(`创建站点容器失败：容器启动后无法停止：${reason}；容器 ${containerId.slice(0, 12)} 已创建，请到容器页处理`)
        }
      }

      const row: WebsiteRecord = {
        id: projectId,
        kind: input.kind,
        name: input.name,
        port: input.port,
        runtimeVersion: input.kind === 'html' ? null : input.runtimeVersion,
        rootDir,
        domain: input.domain,
        containerName,
        containerId,
        imageRef,
        deployCommand: websiteDefaultDeployCommand(input.kind, input.port),
        enabled: false,
        category: 'development',
        expiryAt: null,
        note: input.note,
        gitUrl: input.gitUrl,
        createdAt: new Date().toISOString(),
      }
      try {
        await registry.put(row)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (containerId !== null) {
          await docker.stop(containerId).catch(() => undefined)
          await docker.removeCreated(containerId).catch(() => undefined)
        }
        throw new Error(`网站登记写入失败：${reason}；站点容器已回滚删除，站点目录保留`)
      }

      // 每次站点创建后从登记全量重下发（无域名站点的配置不变，重下发可顺带补发
      // 此前降级期间遗留的路由）；通道不可用时跳过、不报成功，cert 停在 none，
      // 界面横幅如实呈现。
      const pushed = await queueCaddyPush()
      return projectRow(row, pushed.applied ? pushed.hosts : null)
    } finally {
      inProgress.delete(CREATE_MUTEX_KEY)
    }
  }

  async function update(id: string, input: WebsiteUpdateRequest): Promise<WebsiteProject> {
    // 整记录读改写必须与同项目的启停/删除互斥：否则 update 以陈旧全量记录回写，
    // 会静默回滚并发启停刚翻转的 enabled。
    if (inProgress.has(id)) throw new InvalidRequestError(409, '项目正在执行其他操作')
    inProgress.add(id)
    try {
      const row = await record(id)
      const updated: WebsiteRecord = {
        ...row,
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.expiryAt !== undefined ? { expiryAt: input.expiryAt } : {}),
      }
      await registry.put(updated)
      return projectRow(updated, await currentHosts())
    } finally {
      inProgress.delete(id)
    }
  }

  async function setRunning(id: string, running: boolean): Promise<WebsiteProject> {
    if (inProgress.has(id)) throw new InvalidRequestError(409, '项目正在执行其他操作')
    inProgress.add(id)
    try {
      const row = await record(id)
      if (row.kind === 'html') {
        if (row.enabled !== running) {
          // 先落登记再走下发队列（队列内部重新读登记推导整配置）：并发的其他站点
          // 写不会拿旧快照把本次路由回滚；下发被拒（外配/引擎拒绝）时回滚登记，
          // 保持界面回滚与事实一致。通道不可用属降级跳过，登记保留、横幅如实呈现。
          const updated = { ...row, enabled: running }
          await registry.put(updated)
          try {
            const pushed = await queueCaddyPush()
            return projectRow(updated, pushed.applied ? pushed.hosts : null)
          } catch (error) {
            await registry.put(row).catch(() => undefined)
            throw error
          }
        }
        return projectRow(row, await currentHosts())
      }
      if (!row.containerId) throw new InvalidRequestError(409, '站点没有容器')
      try {
        if (running) await docker.start(row.containerId)
        else await docker.stop(row.containerId)
      } catch (error) {
        if (error instanceof InvalidRequestError && error.status === 404) {
          throw new InvalidRequestError(404, '站点容器已不存在，请删除站点后重建')
        }
        throw error
      }
      return projectRow(row, await currentHosts())
    } finally {
      inProgress.delete(id)
    }
  }

  async function logs(id: string): Promise<readonly string[]> {
    const row = await record(id)
    if (row.kind === 'html') return ['静态站点由宿主 Caddy 直接托管，无应用运行日志']
    if (!row.containerId) throw new InvalidRequestError(409, '站点没有容器')
    try {
      return await docker.logs(row.containerId)
    } catch (error) {
      if (error instanceof InvalidRequestError && error.status === 404) {
        throw new InvalidRequestError(404, '站点容器已不存在，请删除站点后重建')
      }
      throw error
    }
  }

  async function remove(id: string): Promise<void> {
    if (inProgress.has(id)) throw new InvalidRequestError(409, '项目正在执行其他操作')
    inProgress.add(id)
    try {
      const row = await record(id)
      if (row.kind !== 'html' && row.containerId !== null) {
        try {
          await docker.stop(row.containerId)
        } catch (error) {
          if (!(error instanceof InvalidRequestError) || error.status !== 404) throw error
        }
      }
      // Caddy 路由回收：下发队列重新读登记并排除本站后全量重下发；失败不阻断资源
      // 删除，报错说明配置残留将在下次下发时回收（通道不可用属降级跳过，不算回收失败）。
      let caddyFailure: string | null = null
      try {
        await queueCaddyPush((rows) => rows.filter((item) => item.id !== id))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        caddyFailure = `反向代理配置回收失败：${reason}；站点资源已删除，配置残留将在下次下发时回收`
      }
      if (row.kind !== 'html' && row.containerId !== null) {
        // 容器已被外部删除时 removeManaged 幂等跳过容器删除，其余步骤照常。
        await docker.removeManaged({
          containerId: row.containerId,
          containerName: row.containerName ?? '',
          projectId: row.id,
          kind: row.kind,
          version: row.runtimeVersion ?? '',
          imageRef: row.imageRef ?? '',
          rootDir: row.rootDir,
          selfContainerId: deps.selfContainerId,
        })
      }
      let dirFailure: string | null = null
      try {
        await docker.removeSiteDir(row.rootDir, deps.mountRoot)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        dirFailure = `站点目录删除失败：${reason}`
      }
      await registry.remove(id)
      if (caddyFailure !== null) throw new Error(caddyFailure)
      if (dirFailure !== null) throw new Error(dirFailure)
    } finally {
      inProgress.delete(id)
    }
  }

  /** 域级对账：走同一条下发队列从 registry 全量重新生成并下发，返回下发后的代理状态。 */
  async function reconcileProxy(): Promise<WebsiteProxyStatus> {
    const { hosts } = expectedProxy(await registry.list())
    const pushed = await queueCaddyPush()
    if (!pushed.applied) return { state: 'unavailable', detail: pushed.detail }
    try {
      const missing = missingHosts(hosts, await caddy.currentConfig())
      return missing.size > 0
        ? { state: 'active', detail: `${missing.size} 个站点的路由未下发` }
        : { state: 'active', detail: null }
    } catch {
      // /load 已成功（2xx 即整配置生效）；复核读取失败不推翻下发事实。
      return { state: 'active', detail: null }
    }
  }

  return { list, create, update, setRunning, logs, remove, reconcileProxy }
}
