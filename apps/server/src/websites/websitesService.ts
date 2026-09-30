import { randomUUID } from 'node:crypto'
import type {
  FirewallPortSync,
  PortMapping,
  WebsiteAccessInput,
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
  WEBSITE_HTML_IMAGE,
  websiteProjectUsesRuntime,
  websiteRuntimeImageRef,
} from '@elysian/contracts'
import { InvalidRequestError, invalidRequest } from '../shared/errors.ts'
import { SERVER_PORT } from '../shared/ports.ts'
import { appliedCertificateFingerprints, appliedManagedHosts, buildCaddyConfig, hasForeignConfig, type CaddyManagedSite } from './caddyConfig.ts'
import { CaddyChannelError, caddyChannelStatus, type WebsiteCaddy } from './websitesCaddy.ts'
import { createMemoryWebsiteCertificateStore, validateWebsiteCertificate, type WebsiteCertificateMaterial, type WebsiteCertificateStore } from './websitesCertificates.ts'
import type { WebsiteDocker } from './websitesDocker.ts'
import { websiteContainerCmd } from './websitesDocker.ts'
import type { WebsiteRecord, WebsiteRegistry } from './websitesRegistry.ts'

/*
 * 网站域编排层：校验（手写中文校验，复用契约纯函数）、查重（名称跨类型全局唯一、
 * 域名唯一、端口三重查重）、容器与站点目录的创建/删除编排、Caddy 配置的推导下发
 * 与漂移呈现。编排顺序与失败路径见规格「动作映射表」与「失败路径」；失败时报
 * 「已做到哪一步、还剩什么」，不伪装完成。
 */

/** 面板与 SSH 保留端口（与容器页 createSpec 同一张表的前三项）。 */
const PANEL_RESERVED_PORTS: readonly number[] = [22, PANEL_PORT, SERVER_PORT]
/** 80/443 归宿主 Caddy，项目容器不能占用。 */
const PROXY_RESERVED_PORTS: readonly number[] = [80, 443]
/** 全局创建互斥键：名称与域名的查重都是 check-then-act，串行化全部创建才能关死并发窗口。 */
const CREATE_MUTEX_KEY = 'create'
const NOTE_MAX_LENGTH = 1024

export type WebsiteCreateRequest = {
  kind: WebsiteProjectKind
  name: string
  port: number
  runtimeVersion: string | null
  access: WebsiteAccessInput
  command: string | null
  gitUrl: string | null
  note: string | null
}

export type WebsiteUpdateRequest = {
  note?: string | null
  expiryAt?: string | null
  command?: string | null
}

/** 访问方式统一入口，密钥只在请求内短暂存在。 */
export function validateWebsiteAccessRequest(input: unknown): WebsiteAccessInput {
  const row = object(input)
  if (row.mode === 'direct') return { mode: 'direct' }
  if (row.mode !== 'domain') throw invalidRequest('请选择访问方式')
  if (typeof row.domain !== 'string' || !isValidWebsiteDomain(row.domain)) throw invalidRequest('域名无效')
  const certificatePem = row.certificatePem
  const privateKeyPem = row.privateKeyPem
  if ((certificatePem === undefined) !== (privateKeyPem === undefined)) throw invalidRequest('请同时上传证书链和私钥')
  if (certificatePem !== undefined && (typeof certificatePem !== 'string' || typeof privateKeyPem !== 'string')) throw invalidRequest('证书文件无效')
  return { mode: 'domain', domain: row.domain.trim().toLowerCase(), ...(certificatePem !== undefined ? { certificatePem: certificatePem as string, privateKeyPem: privateKeyPem as string } : {}) }
}

export type WebsiteService = {
  list(): Promise<WebsiteListReport>
  create(input: WebsiteCreateRequest): Promise<WebsiteMutateResult>
  update(id: string, input: WebsiteUpdateRequest): Promise<WebsiteProject>
  setAccess(id: string, access: WebsiteAccessInput): Promise<WebsiteMutateResult>
  setRunning(id: string, running: boolean): Promise<WebsiteProject>
  logs(id: string): Promise<readonly string[]>
  remove(id: string): Promise<void>
  reconcileProxy(): Promise<WebsiteProxyStatus>
}

/** 创建与访问方式切换的结果：项目之外带回直连端口的防火墙自动开放事实（不联动场景为 null）。 */
export type WebsiteMutateResult = {
  project: WebsiteProject
  firewallPort: FirewallPortSync | null
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
  const access = validateWebsiteAccessRequest(row.access)
  if (access.mode === 'domain' && (!access.certificatePem || !access.privateKeyPem)) throw invalidRequest('域名访问需要上传公开 CA 证书链和私钥')
  const command = kind === 'html' ? websiteDefaultDeployCommand('html', row.port) :
    trimmed(row.command, '启动命令', 2048) ?? websiteDefaultDeployCommand(kind, row.port)
  if (command === null) throw invalidRequest('请填写容器启动命令')
  return {
    kind,
    name: row.name.trim(),
    port: row.port,
    runtimeVersion,
    access,
    command,
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
  if (row.command !== undefined) request.command = trimmed(row.command, '启动命令', 2048)
  return request
}

function effectiveHostIp(hostIp?: string): string {
  return hostIp === undefined || hostIp === '' ? '127.0.0.1' : hostIp
}

function hostIpsOverlap(a: string, b: string): boolean {
  return a === b || a === '0.0.0.0' || b === '0.0.0.0'
}

/** 期望路由投影：只有域名模式生成反向代理路由。 */
function expectedProxy(rows: readonly WebsiteRecord[]): { sites: readonly CaddyManagedSite[]; hosts: Set<string> } {
  const sites: CaddyManagedSite[] = []
  const hosts = new Set<string>()
  for (const row of rows) {
    if (row.accessMode !== 'domain' || row.domain === null) continue
    sites.push({ kind: 'proxy', domain: row.domain, port: row.port })
    hosts.add(row.domain)
  }
  return { sites, hosts }
}

export function createWebsiteService(deps: {
  registry: WebsiteRegistry
  docker: WebsiteDocker
  caddy: WebsiteCaddy
  certificates?: WebsiteCertificateStore
  trustedRoots?: readonly string[]
  mountRoot: string
  listPortBindings(): Promise<readonly PortMapping[]>
  selfContainerId?: string
  /** 直连端口的防火墙自动开放（app.ts 装配层注入）；缺省恒 skipped。 */
  openFirewallPort?: (port: number, note: string) => Promise<FirewallPortSync>
}): WebsiteService {
  const { registry, docker, caddy } = deps
  const certificates = deps.certificates ?? createMemoryWebsiteCertificateStore()
  const inProgress = new Set<string>()
  // 端口自动开放：直连项目把宿主端口发布到 0.0.0.0，创建与切换为直连时在防火墙页
  // 管理的同一份 ufw 里幂等补放行规则；未注入（测试/非容器装配）恒 skipped 不打扰。
  const openFirewallPort = deps.openFirewallPort
    ?? (async (port: number) => ({ state: 'skipped' as const, port, detail: '防火墙片不可用，端口未自动开放' }))

  async function record(id: string): Promise<WebsiteRecord> {
    const found = (await registry.list()).find((row) => row.id === id)
    if (!found) throw new InvalidRequestError(404, `未找到项目 ${id}`)
    return found
  }

  async function currentConfigOrNull(): Promise<unknown | null> {
    try {
      return await caddy.currentConfig()
    } catch {
      return null
    }
  }

  async function projectRow(row: WebsiteRecord, config: unknown | null): Promise<WebsiteProject> {
    let running = false
    let pid: number | null = null
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
    const routeApplied = row.domain !== null && config !== null &&
      appliedManagedHosts(expectedProxy([row]).sites, config).has(row.domain)
    return {
      id: row.id, kind: row.kind, name: row.name, pid,
      containerId: row.containerId, port: row.port,
      runtimeVersion: row.runtimeVersion, rootDir: row.rootDir,
      runState: running ? 'running' : 'stopped',
      accessMode: row.accessMode, domain: row.domain, routeApplied, expiryAt: row.expiryAt, note: row.note,
      certificate: row.certificate ? {
        issuer: row.certificate.issuer,
        notAfter: row.certificate.notAfter,
        fingerprint256: row.certificate.fingerprint256,
        applied: config !== null && appliedCertificateFingerprints(config).has(row.certificate.fingerprint256),
      } : null,
      category: row.category, deployCommand: row.deployCommand, gitUrl: row.gitUrl,
      traffic: { todayMb: 0, totalGb: 0 },
    }
  }

  /** 下发结果：成功给出已下发配置；通道不可用给出中文原因。 */
  type CaddyPushResult = { applied: true; config: unknown } | { applied: false; detail: string | null }

  async function sitesWithCertificates(rows: readonly WebsiteRecord[]): Promise<readonly CaddyManagedSite[]> {
    const sites = expectedProxy(rows).sites
    return Promise.all(sites.map(async (site) => {
      const row = rows.find((item) => item.domain === site.domain)
      if (!row?.certificate) throw new Error(`域名 ${site.domain} 缺少证书登记`)
      const material = await certificates.read(row.certificate.ref)
      return { ...site, ...material }
    }))
  }

  /**
   * 下发核心（站点变更与对账共用一份编排）：读当前配置 → 外部配置防护 → POST /load
   * 整配置原子替换。通道不可用按结果返回（调用方决定跳过还是呈现）；存在面板外
   * 配置（409）或下发被拒时抛中文错误。
   */
  async function pushCaddyConfig(rows: readonly WebsiteRecord[], knownHosts = expectedProxy(rows).hosts): Promise<CaddyPushResult> {
    const sites = await sitesWithCertificates(rows)
    const config = buildCaddyConfig(sites, { adminListen: caddy.adminListen })
    let current: unknown
    try {
      current = await caddy.currentConfig()
    } catch (error) {
      if (error instanceof CaddyChannelError) return { applied: false, detail: caddyChannelStatus(error).detail }
      throw error
    }
    if (hasForeignConfig(current, knownHosts, { adminListen: caddy.adminListen })) {
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
    return { applied: true, config }
  }

  /**
   * 下发队列：同进程内的全部下发串行执行，且每次都从 registry **重新读取**再推导。没有它，
   * 两个并发站点写各自拿着旧快照整配置替换，后发会把先发刚下发的路由回滚掉。
   */
  let pushTail: Promise<unknown> = Promise.resolve()
  function queueCaddyPush(): Promise<CaddyPushResult> {
    const run = pushTail.then(async () => {
      const rows = await registry.list()
      return pushCaddyConfig(rows)
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
    let config: unknown | null
    let proxy: WebsiteProxyStatus
    try {
      config = await caddy.currentConfig()
      const applied = appliedManagedHosts(expectedProxy(rows).sites, config)
      const missing = [...expectedHosts].filter((host) => !applied.has(host))
      proxy = missing.length > 0
        ? { state: 'active', detail: `${missing.length} 个站点的路由未下发` }
        : { state: 'active', detail: null }
    } catch (error) {
      config = null
      proxy = caddyChannelStatus(error)
    }
    return { projects: await Promise.all(rows.map((row) => projectRow(row, config))), proxy }
  }

  async function create(input: WebsiteCreateRequest): Promise<WebsiteMutateResult> {
    // 全局串行化全部创建：名称（跨类型全局唯一）与域名的查重都是跨 await 的
    // check-then-act，按 kind+name 分键会让并发同名/同域创建双双通过查重。
    if (inProgress.has(CREATE_MUTEX_KEY)) throw new InvalidRequestError(409, '网站项目正在创建，请稍后再试')
    inProgress.add(CREATE_MUTEX_KEY)
    try {
      const run = pushTail.then(async () => {
      const rows = await registry.list()
      if (rows.some((row) => row.name === input.name)) {
        throw new InvalidRequestError(409, `项目已存在：${input.name}`)
      }
      const domain = input.access.mode === 'domain' ? input.access.domain : null
      if (domain !== null && rows.some((row) => row.domain === domain)) {
        throw new InvalidRequestError(409, `域名已被绑定：${domain}`)
      }
      await assertPortAvailable(input.port, rows)

      let certificate: WebsiteRecord['certificate'] = null
      if (input.access.mode === 'domain') {
        const material = { certificatePem: input.access.certificatePem!, privateKeyPem: input.access.privateKeyPem! }
        const metadata = validateWebsiteCertificate(material, domain!, deps.trustedRoots)
        certificate = { ...metadata, ref: await certificates.save(material) }
        try { await caddy.currentConfig() } catch (error) {
          await certificates.remove(certificate.ref)
          throw new Error(`Caddy 管理通道不可用：${caddyChannelStatus(error).detail ?? '请重新检测'}`)
        }
      }

      // 目录与镜像先于容器：镜像缺失不建容器；目录建后失败保留（空目录无害）。
      const projectId = randomUUID()
      let rootDir: string
      try { rootDir = await docker.ensureSiteDir(input.name, deps.mountRoot) }
      catch (error) { if (certificate) await certificates.remove(certificate.ref); throw error }
      const imageRef = input.kind === 'html' ? WEBSITE_HTML_IMAGE : websiteRuntimeImageRef(input.kind, input.runtimeVersion)
      let containerId: string | null = null
      let containerName: string | null = null
      if (imageRef !== null) {
        try {
        await docker.ensureImage(imageRef)
        containerName = docker.newContainerName()
        const created = await docker.create({
          imageRef, kind: input.kind, version: input.runtimeVersion ?? 'html',
          projectId, port: input.port, bindSource: rootDir, containerName,
          accessMode: input.access.mode, command: input.command,
        })
        containerId = created.containerId
        } catch (error) { if (certificate) await certificates.remove(certificate.ref); throw error }
      }

      const row: WebsiteRecord = {
        id: projectId,
        kind: input.kind,
        name: input.name,
        port: input.port,
        runtimeVersion: input.kind === 'html' ? null : input.runtimeVersion,
        rootDir,
        domain,
        accessMode: input.access.mode,
        certificate,
        containerName,
        containerId,
        imageRef,
        deployCommand: input.command,
        enabled: false,
        category: 'development',
        expiryAt: null,
        note: input.note,
        gitUrl: input.gitUrl,
        createdAt: new Date().toISOString(),
      }
      let previousConfig: unknown | null = null
      let appliedConfig: unknown | null = null
      let caddyLoaded = false
      try {
        if (domain !== null) {
          previousConfig = await caddy.currentConfig()
          if (hasForeignConfig(previousConfig, expectedProxy(rows).hosts, { adminListen: caddy.adminListen })) throw new InvalidRequestError(409, '宿主 Caddy 存在面板外的配置，拒绝覆盖')
          const sites = await sitesWithCertificates([...rows, row])
          appliedConfig = buildCaddyConfig(sites, { adminListen: caddy.adminListen })
          await caddy.load(appliedConfig)
          caddyLoaded = true
        }
        await registry.put(row)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        let rollbackFailure = false
        if (caddyLoaded && previousConfig !== null) {
          try { await caddy.load(previousConfig) } catch { rollbackFailure = true }
        }
        if (containerId !== null) {
          await docker.removeCreated(containerId).catch(() => undefined)
        }
        if (certificate) await certificates.remove(certificate.ref).catch(() => undefined)
        throw new Error(`网站创建失败：${reason}；容器已回滚，站点目录保留${rollbackFailure ? '；原 Caddy 配置恢复失败，配置可能不同步，请重新下发反向代理配置' : ''}`)
      }

      // 端口自动开放放在登记落账之后：失败不回滚容器（直连端口在宿主本机仍可达，
      // 只是外部不可达），结果如实带回响应由前端呈现。
      const project = await projectRow(row, appliedConfig ?? await currentConfigOrNull())
      const firewallPort = input.access.mode === 'direct'
        ? await openFirewallPort(input.port, `Elysian 网站 ${input.name}`)
        : null
      return { project, firewallPort }
      })
      pushTail = run.catch(() => undefined)
      return await run
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
      if (input.command !== undefined && input.command !== row.deployCommand) {
        if (row.kind === 'html') throw invalidRequest('HTML 项目使用固定 Nginx 启动命令')
        websiteContainerCmd(row.kind, input.command)
        if (!row.containerId || !row.imageRef) throw new InvalidRequestError(409, '站点容器不存在，请删除项目后重建')
        const oldRunning = object(object(await docker.inspect(row.containerId)).State).Running === true
        const containerName = docker.newContainerName()
        const created = await docker.create({
          imageRef: row.imageRef, kind: row.kind, version: row.runtimeVersion ?? 'html', projectId: row.id,
          port: row.port, bindSource: row.rootDir, containerName, accessMode: row.accessMode, command: input.command,
        })
        let stopped = false
        let registered = false
        try {
          if (oldRunning) { await docker.stop(row.containerId); stopped = true; await docker.start(created.containerId) }
          updated.containerId = created.containerId
          updated.containerName = containerName
          updated.deployCommand = input.command
          await registry.put(updated)
          registered = true
          await docker.removeManaged({ containerId: row.containerId, containerName: row.containerName ?? '', projectId: row.id,
            kind: row.kind, version: row.runtimeVersion ?? 'html', imageRef: row.imageRef, rootDir: row.rootDir,
            selfContainerId: deps.selfContainerId })
        } catch (error) {
          const failures: string[] = []
          if (registered) try { await registry.put(row) } catch { failures.push('登记') }
          await docker.stop(created.containerId).catch(() => undefined)
          try { await docker.removeCreated(created.containerId) } catch { failures.push('新容器') }
          if (stopped) try { await docker.start(row.containerId) } catch { failures.push('原容器') }
          throw new Error(`启动命令保存失败：${error instanceof Error ? error.message : String(error)}${failures.length ? `；${failures.join('、')}恢复失败，配置可能不同步` : '；原容器已恢复'}`)
        }
      } else await registry.put(updated)
      return projectRow(updated, await currentConfigOrNull())
    } finally {
      inProgress.delete(id)
    }
  }

  async function setAccess(id: string, access: WebsiteAccessInput): Promise<WebsiteMutateResult> {
    if (inProgress.has(CREATE_MUTEX_KEY) || inProgress.has(id)) {
      throw new InvalidRequestError(409, '项目正在执行其他操作')
    }
    inProgress.add(CREATE_MUTEX_KEY)
    inProgress.add(id)
    try {
      const run = pushTail.then(async () => {
        const rows = await registry.list()
        const row = rows.find((item) => item.id === id)
        if (!row) throw new InvalidRequestError(404, `未找到项目 ${id}`)
        const domain = access.mode === 'domain' ? access.domain : null
        if (domain && rows.some((item) => item.id !== id && item.domain === domain)) throw new InvalidRequestError(409, `域名已被绑定：${domain}`)
        let certificate: WebsiteRecord['certificate'] = null
        let stagedRef: string | null = null
        if (access.mode === 'domain') {
          let material: WebsiteCertificateMaterial
          if (access.certificatePem && access.privateKeyPem) {
            material = { certificatePem: access.certificatePem, privateKeyPem: access.privateKeyPem }
            const metadata = validateWebsiteCertificate(material, access.domain, deps.trustedRoots)
            stagedRef = await certificates.save(material)
            certificate = { ...metadata, ref: stagedRef }
          } else {
            if (!row.certificate) throw invalidRequest('域名访问需要上传公开 CA 证书链和私钥')
            material = await certificates.read(row.certificate.ref)
            validateWebsiteCertificate(material, access.domain, deps.trustedRoots)
            certificate = row.certificate
          }
        }
        const changingMode = row.accessMode !== access.mode
        const updated: WebsiteRecord = { ...row, accessMode: access.mode, domain, certificate }
        if (!changingMode && row.domain === domain && !stagedRef) return { project: await projectRow(row, await currentConfigOrNull()), firewallPort: null }
        let previousConfig: unknown | null = null
        let nextConfig: unknown | null = null
        let caddyLoaded = false
        let newContainerId: string | null = null
        let oldStopped = false
        let registryChanged = false
        let oldRunning = false
        try {
          oldRunning = row.containerId ? object(object(await docker.inspect(row.containerId)).State).Running === true : false
          if (changingMode) {
            if (!row.imageRef || !row.containerId) throw new InvalidRequestError(409, '站点容器不存在，请删除项目后重建')
            await docker.ensureImage(row.imageRef)
            const containerName = docker.newContainerName()
            newContainerId = (await docker.create({
              imageRef: row.imageRef, kind: row.kind, version: row.runtimeVersion ?? 'html',
              projectId: row.id, port: row.port, bindSource: row.rootDir, containerName,
              accessMode: access.mode, command: row.deployCommand,
            })).containerId
            updated.containerId = newContainerId
            updated.containerName = containerName
            if (oldRunning) {
              await docker.stop(row.containerId)
              oldStopped = true
              await docker.start(newContainerId)
            }
          }
          if (row.domain !== null || domain !== null) {
            previousConfig = await caddy.currentConfig()
            if (hasForeignConfig(previousConfig, expectedProxy(rows).hosts, { adminListen: caddy.adminListen })) throw new InvalidRequestError(409, '宿主 Caddy 存在面板外的配置，拒绝覆盖')
            nextConfig = buildCaddyConfig(await sitesWithCertificates(rows.map((item) => item.id === id ? updated : item)), { adminListen: caddy.adminListen })
            await caddy.load(nextConfig)
            caddyLoaded = true
          }
          await registry.put(updated)
          registryChanged = true
          if (changingMode && row.containerId) await docker.removeManaged({
            containerId: row.containerId, containerName: row.containerName ?? '', projectId: row.id,
            kind: row.kind, version: row.runtimeVersion ?? 'html', imageRef: row.imageRef ?? '', rootDir: row.rootDir,
            selfContainerId: deps.selfContainerId,
          })
          if (row.certificate && row.certificate.ref !== certificate?.ref) await certificates.remove(row.certificate.ref)
          // 切换为直连：端口新发布到 0.0.0.0，与创建同口径自动开放；失败不回滚切换。
          const project = await projectRow(updated, nextConfig ?? await currentConfigOrNull())
          const firewallPort = changingMode && access.mode === 'direct'
            ? await openFirewallPort(row.port, `Elysian 网站 ${row.name}`)
            : null
          return { project, firewallPort }
        } catch (error) {
          const failures: string[] = []
          if (registryChanged) try { await registry.put(row) } catch { failures.push('登记') }
          if (caddyLoaded && previousConfig) try { await caddy.load(previousConfig) } catch { failures.push('Caddy 配置') }
          if (newContainerId) {
            await docker.stop(newContainerId).catch(() => undefined)
            try { await docker.removeCreated(newContainerId) } catch { failures.push('新容器') }
          }
          if (oldStopped && row.containerId) try { await docker.start(row.containerId) } catch { failures.push('原容器') }
          if (stagedRef) await certificates.remove(stagedRef).catch(() => undefined)
          const reason = error instanceof Error ? error.message : String(error)
          throw new Error(`访问配置保存失败：${reason}${failures.length ? `；${failures.join('、')}恢复失败，配置可能不同步，请检查后重新对账` : '；原访问配置已恢复'}`)
        }
      })
      pushTail = run.catch(() => undefined)
      return await run
    } finally {
      inProgress.delete(id)
      inProgress.delete(CREATE_MUTEX_KEY)
    }
  }

  async function setRunning(id: string, running: boolean): Promise<WebsiteProject> {
    if (inProgress.has(id)) throw new InvalidRequestError(409, '项目正在执行其他操作')
    inProgress.add(id)
    try {
      const row = await record(id)
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
      return projectRow(row, await currentConfigOrNull())
    } finally {
      inProgress.delete(id)
    }
  }

  async function logs(id: string): Promise<readonly string[]> {
    const row = await record(id)
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
    if (inProgress.has(id) || inProgress.has(CREATE_MUTEX_KEY)) throw new InvalidRequestError(409, '项目正在执行其他操作')
    inProgress.add(id)
    inProgress.add(CREATE_MUTEX_KEY)
    try {
      const run = pushTail.then(async () => {
        const row = await record(id)
        if (row.containerId !== null) {
          try {
            await docker.stop(row.containerId)
          } catch (error) {
            if (!(error instanceof InvalidRequestError) || error.status !== 404) throw error
          }
        }
        // Caddy 路由回收与登记删除同处下发队列，避免并发创建重新带回旧路由。
        let caddyFailure: string | null = null
        try {
          const rows = await registry.list()
          await pushCaddyConfig(rows.filter((item) => item.id !== id), expectedProxy(rows).hosts)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          caddyFailure = `反向代理配置回收失败：${reason}；站点资源已删除，配置残留将在下次下发时回收`
        }
        if (row.containerId !== null) {
          // 容器已被外部删除时 removeManaged 幂等跳过容器删除，其余步骤照常。
          await docker.removeManaged({
            containerId: row.containerId,
            containerName: row.containerName ?? '',
            projectId: row.id,
            kind: row.kind,
            version: row.runtimeVersion ?? 'html',
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
        if (row.certificate) await certificates.remove(row.certificate.ref)
        if (caddyFailure !== null) throw new Error(caddyFailure)
        if (dirFailure !== null) throw new Error(dirFailure)
      })
      pushTail = run.catch(() => undefined)
      await run
    } finally {
      inProgress.delete(id)
      inProgress.delete(CREATE_MUTEX_KEY)
    }
  }

  /** 域级对账：走同一条下发队列从 registry 全量重新生成并下发，返回下发后的代理状态。 */
  async function reconcileProxy(): Promise<WebsiteProxyStatus> {
    const pushed = await queueCaddyPush()
    if (!pushed.applied) return { state: 'unavailable', detail: pushed.detail }
    try {
      const { sites, hosts } = expectedProxy(await registry.list())
      const applied = appliedManagedHosts(sites, await caddy.currentConfig())
      const missing = [...hosts].filter((host) => !applied.has(host))
      return missing.length > 0
        ? { state: 'active', detail: `${missing.length} 个站点的路由未下发` }
        : { state: 'active', detail: null }
    } catch {
      // /load 已成功（2xx 即整配置生效）；复核读取失败不推翻下发事实。
      return { state: 'active', detail: null }
    }
  }

  return { list, create, update, setAccess, setRunning, logs, remove, reconcileProxy }
}
