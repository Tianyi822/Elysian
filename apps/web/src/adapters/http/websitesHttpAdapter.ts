import { withRequestDeadline } from './requestDeadline'
import type { WebsiteSource, WebsiteDeploymentTask, WebsiteDeploymentLogs } from '@elysian/contracts'
import type {
  WebsiteCategory,
  WebsiteAccessMode,
  WebsiteListReport,
  WebsiteProject,
  WebsiteProjectKind,
  WebsiteProxyState,
  WebsiteProxyStatus,
  WebsiteRunState,
} from '@elysian/contracts'
import {
  WEBSITE_CATEGORIES,
  WEBSITE_PROJECT_KINDS,
  WEBSITE_PROXY_STATES,
  WEBSITE_RUN_STATES,
  parseWebsiteRuntimeCatalogReport,
} from '@elysian/contracts'
import type { WebsitesAdapter, WebsiteMutateResult } from '../../contracts/adapters'
import { fetchWithSession, reportUnauthorized } from './unauthorized'
import { parseFirewallPortSync } from './firewallHttpAdapter'

/*
 * 浏览器侧同源网站管理（Docker 运行时，/api/websites）。容器生命周期、站点目录
 * 与宿主 Caddy 配置都由容器内的 server 片执行，这里只做 JSON 形状校验与中文
 * 错误翻译，风格与 filesHttpAdapter 一致：解析函数全部导出，测试直接喂样本。
 */

/** 删除站点的确认正文常量：与确认弹窗文案、服务端校验三方共用同一字面量。 */
const DELETE_WEBSITE_AND_DATA = 'DELETE_WEBSITE_AND_DATA'

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(message)
  }
  return value as Record<string, unknown>
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  message: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(message)
  }
  return value as T
}

function stringOrNull(value: unknown, message: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(message)
  return value
}

/** 校验流量统计形状：真实实现无统计来源、恒为 0，但字段必须齐全。 */
function parseWebsiteTraffic(value: unknown): WebsiteProject['traffic'] {
  const row = asObject(value, '网站项目流量响应无效')
  if (typeof row.todayMb !== 'number' || typeof row.totalGb !== 'number') {
    throw new Error('网站项目流量响应无效')
  }
  return { todayMb: row.todayMb, totalGb: row.totalGb }
}

/** 校验单个项目：标识、类型、运行状态、证书与分类取枚举，PID 与容器 ID 可空。 */
export function parseWebsiteProject(value: unknown): WebsiteProject {
  const row = asObject(value, '网站项目响应无效')
  if (typeof row.id !== 'string' || row.id.length === 0) {
    throw new Error('网站项目标识响应无效')
  }
  if (typeof row.name !== 'string' || typeof row.rootDir !== 'string') {
    throw new Error('网站项目响应无效')
  }
  if (typeof row.port !== 'number' || !Number.isInteger(row.port)) {
    throw new Error('网站项目端口响应无效')
  }
  if (row.pid !== null && typeof row.pid !== 'number') {
    throw new Error('网站项目进程号响应无效')
  }
  if (row.containerId !== null && typeof row.containerId !== 'string') {
    throw new Error('网站项目容器 ID 响应无效')
  }
  if (typeof row.routeApplied !== 'boolean') {
    throw new Error('网站项目路由状态响应无效')
  }
  let certificate: WebsiteProject['certificate'] = null
  if (row.certificate !== null) {
    const cert = asObject(row.certificate, '网站项目证书响应无效')
    if (typeof cert.issuer !== 'string' || typeof cert.notAfter !== 'string' ||
      typeof cert.fingerprint256 !== 'string' || typeof cert.applied !== 'boolean') {
      throw new Error('网站项目证书响应无效')
    }
    certificate = { issuer: cert.issuer, notAfter: cert.notAfter, fingerprint256: cert.fingerprint256, applied: cert.applied }
  }
  return {
    ...(row.currentRelease ? { currentRelease: row.currentRelease as WebsiteProject['currentRelease'] } : {}),
    ...(row.previousRelease ? { previousRelease: row.previousRelease as WebsiteProject['previousRelease'] } : {}),
    ...(typeof row.buildRuntimeVersion === 'string' ? { buildRuntimeVersion: row.buildRuntimeVersion } : {}),
    ...(row.deploymentTarget === 'static' || row.deploymentTarget === 'service' ? { deploymentTarget: row.deploymentTarget } : {}),
    id: row.id,
    kind: oneOf<WebsiteProjectKind>(row.kind, WEBSITE_PROJECT_KINDS, '网站项目类型响应无效'),
    name: row.name,
    pid: row.pid as number | null,
    containerId: row.containerId as string | null,
    port: row.port,
    runtimeVersion: stringOrNull(row.runtimeVersion, '网站项目运行时版本响应无效'),
    rootDir: row.rootDir,
    runState: oneOf<WebsiteRunState>(row.runState, WEBSITE_RUN_STATES, '网站项目运行状态响应无效'),
    accessMode: oneOf<WebsiteAccessMode>(row.accessMode, ['direct', 'domain'], '网站项目访问方式响应无效'),
    domain: stringOrNull(row.domain, '网站项目域名响应无效'),
    routeApplied: row.routeApplied,
    expiryAt: stringOrNull(row.expiryAt, '网站项目到期时间响应无效'),
    note: stringOrNull(row.note, '网站项目备注响应无效'),
    certificate,
    category: oneOf<WebsiteCategory>(row.category, WEBSITE_CATEGORIES, '网站项目分类响应无效'),
    deployCommand: stringOrNull(row.deployCommand, '网站项目部署命令响应无效'),
    gitUrl: stringOrNull(row.gitUrl, '网站项目 Git 地址响应无效'),
    traffic: parseWebsiteTraffic(row.traffic),
  }
}

/** 校验创建与切换访问方式的响应：项目附带可空的防火墙端口开放结果。 */
export function parseWebsiteMutateResult(value: unknown): WebsiteMutateResult {
  const row = asObject(value, '网站项目变更响应无效')
  if (!('project' in row)) {
    throw new Error('网站项目变更响应无效')
  }
  return {
    project: parseWebsiteProject(row.project),
    firewallPort: parseFirewallPortSync(row.firewallPort ?? null),
  }
}

/** 校验反向代理通道状态：state 取枚举，detail 可空。 */
export function parseWebsiteProxyStatus(value: unknown): WebsiteProxyStatus {
  const row = asObject(value, '反向代理状态响应无效')
  return {
    state: oneOf<WebsiteProxyState>(row.state, WEBSITE_PROXY_STATES, '反向代理状态取值响应无效'),
    detail: stringOrNull(row.detail, '反向代理状态详情响应无效'),
  }
}

/** 校验 GET /（列表）响应：项目数组附带反向代理通道状态。 */
export function parseWebsiteListReport(body: unknown): WebsiteListReport {
  const row = asObject(body, '网站列表响应无效')
  if (!Array.isArray(row.projects)) {
    throw new Error('网站列表响应无效：应为数组')
  }
  return {
    projects: row.projects.map((project) => parseWebsiteProject(project)),
    proxy: parseWebsiteProxyStatus(row.proxy),
  }
}

/** 校验 GET /:id/logs 响应：服务端返回 { logs: [...] }（HTML 站点为单行托管说明）。 */
export function parseWebsiteLogsResponse(body: unknown): readonly string[] {
  const row = asObject(body, '网站日志响应无效')
  if (!Array.isArray(row.logs)) {
    throw new Error('网站日志响应无效：应为数组')
  }
  return row.logs.map((line) => {
    if (typeof line !== 'string') throw new Error('网站日志行响应无效')
    return line
  })
}

/** 校验 POST /proxy/reconcile 响应：下发后的代理状态与是否实际下发。 */
export function parseWebsiteReconcileResponse(body: unknown): {
  proxy: WebsiteProxyStatus
  applied: boolean
} {
  const row = asObject(body, '反向代理对账响应无效')
  if (typeof row.applied !== 'boolean') {
    throw new Error('反向代理对账结果响应无效')
  }
  return { proxy: parseWebsiteProxyStatus(row.proxy), applied: row.applied }
}

function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  return withRequestDeadline(init, (bounded) => readJson(url, bounded), /\/sources\/(?:archive|git)(?:\?|$)/.test(url) ? 10 * 60_000 : undefined)
}

async function readJson(url: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetchWithSession(url, { ...init, cache: 'no-store' })
  } catch {
    throw new Error('网站管理请求网络失败')
  }
  if (!response.ok) {
    if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
    const detail = await response
      .json()
      .then((body) => (body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null))
      .catch(() => null)
    throw new Error(detail ?? `网站管理请求失败：HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error('网站管理响应不是有效 JSON')
  }
}

/**
 * Docker 运行时的网站管理 adapter：版本目录与项目管理落到 /api/websites/*。
 * 项目 id 经一次 encodeURIComponent 进路径（id 由服务端生成，正常是
 * URL 安全字符，编码只兜异常形态）；删除携带确认正文，缺确认服务端 400。
 */
export function createHttpWebsitesAdapter(baseUrl = '/api/websites'): WebsitesAdapter {
  const sendJson = (path: string, method: string, payload?: Record<string, unknown>): Promise<unknown> =>
    requestJson(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    })
  return {
    deployment: {
      async archive(file, mode, signal) { return parseDeploymentSource(await requestJson(`${baseUrl}/sources/archive?mode=${mode}`, { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }, signal })) },
      async git(input, signal) { return parseDeploymentSource(await requestJson(`${baseUrl}/sources/git`, { method: 'POST', body: JSON.stringify(input), headers: { 'content-type': 'application/json' }, signal })) },
      async source(id, signal) { return parseDeploymentSource(await requestJson(`${baseUrl}/sources/${encodeURIComponent(id)}`, { signal })) },
      async discardSource(id) { await sendJson(`/sources/${encodeURIComponent(id)}`, 'DELETE') },
      async submit(input) { return parseDeploymentTask(await sendJson('/deployments', 'POST', { ...input })) },
      async list() { const rows = await requestJson(`${baseUrl}/deployments`); if (!Array.isArray(rows)) throw new Error('部署任务列表无效'); return rows.map(parseDeploymentTask) },
      async task(id) { return parseDeploymentTask(await requestJson(`${baseUrl}/deployments/${encodeURIComponent(id)}`)) },
      async logs(id, offset) { const row = asObject(await requestJson(`${baseUrl}/deployments/${encodeURIComponent(id)}/logs?offset=${offset}`), '部署日志无效'); if (!Array.isArray(row.lines) || !row.lines.every((line) => typeof line === 'string') || typeof row.next !== 'number' || typeof row.total !== 'number') throw new Error('部署日志无效'); return row as WebsiteDeploymentLogs },
      async cancel(id) { await sendJson(`/deployments/${encodeURIComponent(id)}/cancel`, 'POST', {}) },
      async resume(id, config) { return parseDeploymentTask(await sendJson(`/deployments/${encodeURIComponent(id)}/resume`, 'POST', { ...config })) },
      async rollback(projectId) { return parseDeploymentTask(await sendJson(`/deployments/rollback/${encodeURIComponent(projectId)}`, 'POST', {})) },
    },
    async runtimeCatalog(signal) {
      return parseWebsiteRuntimeCatalogReport(await requestJson(`${baseUrl}/runtimes`, { signal }))
    },
    async list() {
      return parseWebsiteListReport(await requestJson(baseUrl))
    },

    async create(kind, input) {
      return parseWebsiteMutateResult(await sendJson('/', 'POST', {
        kind,
        name: input.name,
        port: input.port,
        runtimeVersion: input.runtimeVersion ?? null,
        access: input.access,
        command: input.command ?? null,
        gitUrl: input.gitUrl ?? null,
        note: input.note ?? null,
      }))
    },

    async update(projectId, input) {
      return parseWebsiteProject(await sendJson(`/${encodeURIComponent(projectId)}`, 'PUT', {
        note: input.note ?? null,
        expiryAt: input.expiryAt ?? null,
        ...(input.command === undefined ? {} : { command: input.command }),
      }))
    },

    async setAccess(projectId, access) {
      return parseWebsiteMutateResult(await sendJson(`/${encodeURIComponent(projectId)}/access`, 'PUT', access))
    },

    async remove(projectId) {
      // 删除是危险动作：确认正文由服务端校验，缺确认直接 400。
      await sendJson(`/${encodeURIComponent(projectId)}`, 'DELETE', {
        confirm: DELETE_WEBSITE_AND_DATA,
      })
    },

    async setRunning(projectId, running) {
      return parseWebsiteProject(
        await sendJson(`/${encodeURIComponent(projectId)}/running`, 'POST', { running }),
      )
    },

    async logs(projectId) {
      return parseWebsiteLogsResponse(
        await requestJson(`${baseUrl}/${encodeURIComponent(projectId)}/logs`),
      )
    },

    async reconcileProxy() {
      // 通道不可用时服务端 applied=false 并如实返回状态，这里只透传 proxy。
      const { proxy } = parseWebsiteReconcileResponse(await sendJson('/proxy/reconcile', 'POST', {}))
      return proxy
    },
  }
}

function deploymentStrings(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}
function validateDeploymentConfig(value: unknown) {
  const config = asObject(value, '部署配置响应无效')
  if (typeof config.candidateId !== 'string' || typeof config.command !== 'string' || typeof config.skipTests !== 'boolean' || !['service', 'static'].includes(String(config.target))) throw new Error('部署配置响应无效')
  for (const key of ['buildVersion', 'runtimeVersion', 'toolVersion', 'entry', 'artifact']) if (config[key] !== undefined && typeof config[key] !== 'string') throw new Error('部署配置响应无效')
  for (const key of ['testSteps', 'buildSteps']) if (config[key] !== undefined && !deploymentStrings(config[key])) throw new Error('部署配置响应无效')
}
export function parseDeploymentSource(value: unknown): WebsiteSource {
  const row = asObject(value, '项目来源响应无效')
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.createdAt !== 'string' || typeof row.expiresAt !== 'string' || !['preparing', 'ready', 'failed', 'interrupted'].includes(String(row.state)) || !['source', 'artifact'].includes(String(row.mode)) || !['archive', 'git'].includes(String(row.type))) throw new Error('项目来源响应无效')
  if (row.report !== undefined) {
    const report = asObject(row.report, '项目识别报告无效')
    if (!Array.isArray(report.candidates) || !deploymentStrings(report.warnings)) throw new Error('项目识别报告无效')
    for (const value of report.candidates) {
      const candidate = asObject(value, '项目识别候选无效')
      if (typeof candidate.id !== 'string' || typeof candidate.directory !== 'string' || !WEBSITE_PROJECT_KINDS.includes(candidate.kind as WebsiteProjectKind) || !['javac', 'maven', 'gradle', 'npm', 'pnpm', 'yarn', 'bun', 'go', 'pip', 'uv', 'poetry', 'static', 'artifact'].includes(String(candidate.tool)) || typeof candidate.wrapper !== 'boolean' || typeof candidate.suggestedCommand !== 'string') throw new Error('项目识别候选无效')
      for (const key of ['entries', 'testSteps', 'buildSteps', 'artifacts', 'warnings']) if (!deploymentStrings(candidate[key])) throw new Error('项目识别候选无效')
    }
  } else if (row.state === 'ready') throw new Error('项目识别报告无效')
  return row as WebsiteSource
}
export function parseDeploymentTask(value: unknown): WebsiteDeploymentTask {
  const row = asObject(value, '部署任务响应无效')
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.sourceId !== 'string' || typeof row.stage !== 'string' || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string' || !['queued', 'building', 'awaiting-config', 'publishing', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(row.state)) || !['pending', 'passed', 'failed', 'absent', 'skipped'].includes(String(row.testResult))) throw new Error('部署任务响应无效')
  if (row.projectStatus !== undefined && !['present', 'deleted', 'not-created'].includes(String(row.projectStatus))) throw new Error('部署项目状态无效')
  validateDeploymentConfig(row.config)
  if (row.artifacts !== undefined && !deploymentStrings(row.artifacts)) throw new Error('部署产物响应无效')
  return row as WebsiteDeploymentTask
}
