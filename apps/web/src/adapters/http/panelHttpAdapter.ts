import type { PanelCommit, PanelInfo, PanelPorts, PanelTask, PanelTaskReport, PanelUpdate, PanelUpdatePreflight } from '@elysian/contracts'
import { validatePanelPorts } from '@elysian/contracts'
import type { PanelAdapter } from '../../contracts/adapters'
import { fetchWithSession, reportUnauthorized } from './unauthorized'

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('面板维护响应无效')
  return value as Record<string, unknown>
}
function ports(value: unknown): PanelPorts {
  const row = object(value)
  if (typeof row.frontendPort !== 'number' || typeof row.backendPort !== 'number') throw new Error('面板端口响应无效')
  const result = { frontendPort: row.frontendPort, backendPort: row.backendPort }
  if (validatePanelPorts(result)) throw new Error('面板端口响应无效')
  return result
}
export function parsePanelTask(value: unknown): PanelTask {
  const row = object(value)
  for (const key of ['id', 'kind', 'state', 'phase', 'createdAt', 'updatedAt', 'targetCommit', 'error']) if (typeof row[key] !== 'string') throw new Error('面板任务响应无效')
  if (!['ports', 'restart', 'update'].includes(String(row.kind)) || !['queued', 'running', 'succeeded', 'failed', 'rolled-back', 'recovery-failed'].includes(String(row.state))) throw new Error('面板任务状态无效')
  if (row.updateChannel !== undefined && row.updateChannel !== 'commit' && row.updateChannel !== 'release') throw new Error('面板任务更新策略无效')
  if (row.updateSource !== undefined && row.updateSource !== 'github' && row.updateSource !== 'gitee') throw new Error('面板任务更新来源无效')
  if (row.releaseTag !== undefined && typeof row.releaseTag !== 'string') throw new Error('面板任务发版标签无效')
  if (row.cliRegistration !== undefined) {
    const registration = object(row.cliRegistration)
    if (!['pending', 'succeeded', 'failed'].includes(String(registration.status)) || (registration.error !== undefined && typeof registration.error !== 'string')) throw new Error('CLI 注册状态无效')
  }
  if (row.workerDead !== undefined && typeof row.workerDead !== 'boolean') throw new Error('面板任务维护进程状态无效')
  if (row.workerStatus !== undefined && !['alive', 'dead', 'unknown'].includes(String(row.workerStatus))) throw new Error('面板任务维护进程状态无效')
  if (row.failedPhase !== undefined && typeof row.failedPhase !== 'string') throw new Error('面板任务失败阶段无效')
  if (row.download !== undefined) {
    const download = object(row.download)
    if (typeof download.fileName !== 'string' || !['downloading', 'verifying', 'ready'].includes(String(download.status)) || typeof download.updatedAt !== 'string' || !Number.isFinite(Date.parse(download.updatedAt))) throw new Error('安装包下载进度无效')
    for (const key of ['completedBytes', 'totalBytes', 'bytesPerSecond']) if (!Number.isSafeInteger(download[key]) || Number(download[key]) < 0) throw new Error('安装包下载进度无效')
    if (Number(download.totalBytes) <= 0 || Number(download.completedBytes) > Number(download.totalBytes) || (download.status !== 'downloading' && download.completedBytes !== download.totalBytes)) throw new Error('安装包下载进度无效')
  }
  return { ...row, oldPorts: ports(row.oldPorts), newPorts: ports(row.newPorts) } as PanelTask
}
export function parsePanelInfo(value: unknown): PanelInfo {
  const row = object(value)
  for (const key of ['commit', 'buildTime', 'repository', 'reason']) if (typeof row[key] !== 'string') throw new Error('面板信息响应无效')
  if (typeof row.available !== 'boolean') throw new Error('面板维护能力响应无效')
  if (row.resourcePreflightVersion !== undefined && (!Number.isSafeInteger(row.resourcePreflightVersion) || Number(row.resourcePreflightVersion) < 1)) throw new Error('面板资源预检能力响应无效')
  return { ...row, ports: ports(row.ports), activeTask: row.activeTask === null ? null : parsePanelTask(row.activeTask), lastTask: row.lastTask === null ? null : parsePanelTask(row.lastTask) } as PanelInfo
}
export function parsePanelPreflight(value: unknown): PanelUpdatePreflight {
  const row = object(value), memory = object(row.memory), disk = object(row.disk)
  if (typeof row.id !== 'string' || !row.id || typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt))) throw new Error('更新预检标识无效')
  for (const key of ['totalBytes', 'availableBytes', 'requiredBytes', 'swapTotalBytes', 'swapFreeBytes']) {
    if (!Number.isSafeInteger(memory[key]) || Number(memory[key]) < 0) throw new Error('更新预检内存响应无效')
  }
  if (Number(memory.totalBytes) <= 0 || Number(memory.requiredBytes) <= 0 || Number(memory.availableBytes) > Number(memory.totalBytes) || Number(memory.swapFreeBytes) > Number(memory.swapTotalBytes)) throw new Error('更新预检内存响应无效')
  if (!Number.isSafeInteger(disk.availableBytes) || Number(disk.availableBytes) < 0 || !Number.isSafeInteger(row.activeAgentRuns) || Number(row.activeAgentRuns) < 0) throw new Error('更新预检资源响应无效')
  if (!Array.isArray(row.load) || row.load.length !== 3 || row.load.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new Error('更新预检负载响应无效')
  if (typeof row.needsRelease !== 'boolean' || typeof row.stopPanelRecommended !== 'boolean' || (row.blockedReason !== undefined && typeof row.blockedReason !== 'string') || !Array.isArray(row.candidates)) throw new Error('更新预检停机清单无效')
  const seen = new Set<string>()
  for (const item of row.candidates) {
    const candidate = object(item)
    if (typeof candidate.id !== 'string' || seen.has(candidate.id) || typeof candidate.name !== 'string' || !['container', 'service'].includes(String(candidate.kind)) || typeof candidate.recommended !== 'boolean' || candidate.memoryBytes !== null && (!Number.isSafeInteger(candidate.memoryBytes) || Number(candidate.memoryBytes) < 0)) throw new Error('更新预检停机对象无效')
    if (candidate.kind === 'container' ? !/^container:[a-f0-9]{64}$/.test(candidate.id) : !/^service:[A-Za-z0-9_.@:-]+\.service$/.test(candidate.id)) throw new Error('更新预检停机对象标识无效')
    if (candidate.disabledReason !== undefined && typeof candidate.disabledReason !== 'string') throw new Error('更新预检停机对象说明无效')
    seen.add(candidate.id)
  }
  return row as PanelUpdatePreflight
}
/** 更新日志：后端直接回一个数组，因此不走 object() 的单对象校验。 */
export function parsePanelCommits(value: unknown): PanelCommit[] {
  if (!Array.isArray(value)) throw new Error('更新日志响应无效')
  return value.map((item) => {
    const { sha, message, time } = object(item)
    if (typeof sha !== 'string' || typeof message !== 'string' || typeof time !== 'string') throw new Error('更新日志响应无效')
    return { sha, message, time }
  })
}
/** 网络层失败（连不上、30 秒中止、响应体损坏）的标记：调用方据此区分「断连」与「HTTP 错误响应」。 */
export class PanelNetworkError extends Error {}
export class PanelHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 30000)
  const cancel = () => abort.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  try {
    const response = await fetchWithSession(path, { method, signal: abort.signal, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    if (response.status === 401) { reportUnauthorized(response); throw new PanelHttpError('登录状态已失效，请重新登录', 401) }
    const data: unknown = await response.json()
    if (!response.ok) { const row = object(data); throw new PanelHttpError(typeof row.error === 'string' ? row.error : `面板维护请求失败：HTTP ${response.status}`, response.status) }
    return data
  } catch (cause) {
    // 网络失败与 HTTP 错误响应分流：后者已在上面抛出服务端中文错误，原样透传；
    // 只有网络层失败才归类为「面板连接失败」，供轮询侧计入断连预算。
    if (cause instanceof TypeError || cause instanceof SyntaxError || cause instanceof DOMException) throw new PanelNetworkError('面板连接失败或响应无效，请稍后重试')
    throw cause
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
}
export function createHttpPanelAdapter(base = '/api/panel'): PanelAdapter {
  return {
    preflightUpdate: async ({ channel, source, targetCommit, releaseTag }) => parsePanelPreflight(await request(`${base}/update/preflight`, 'POST', { channel, source, targetCommit, releaseTag })),
    info: async (signal) => parsePanelInfo(await request(base, 'GET', undefined, signal)),
    async checkUpdate(channel, source) {
      const row = object(await request(`${base}/update?channel=${channel}&source=${source}`))
      for (const key of ['repository', 'branch', 'currentCommit', 'targetCommit', 'message', 'releaseTag']) if (typeof row[key] !== 'string') throw new Error('更新信息响应无效')
      if (typeof row.available !== 'boolean') throw new Error('更新信息响应无效')
      if (row.channel !== channel) throw new Error('更新信息与所选策略不一致，请重新检查')
      if (row.source !== source) throw new Error('更新信息与所选来源不一致，请重新检查')
      if (row.available && (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(row.targetCommit)) || (channel === 'release' && row.releaseTag === ''))) throw new Error('更新目标响应无效')
      return row as PanelUpdate
    },
    commits: async (channel, source) => parsePanelCommits(await request(`${base}/commits?channel=${channel}&source=${source}`)),
    retryCLIRegistration: async (id) => parsePanelTask(await request(`${base}/tasks/${encodeURIComponent(id)}/cli-registration/retry`, 'POST', {})),
    ports: async (value, requestId) => parsePanelTask(await request(`${base}/ports`, 'PUT', { ...value, requestId })),
    restart: async (requestId) => parsePanelTask(await request(`${base}/restart`, 'POST', { requestId })),
    update: async ({ channel, source, targetCommit, releaseTag, resourcePlan }, requestId) => parsePanelTask(await request(`${base}/update`, 'POST', { channel, source, targetCommit, releaseTag, ...(resourcePlan ? { resourcePlan } : {}), requestId })),
    async task(id, offset = 0, signal) {
      const row = object(await request(`${base}/tasks/${encodeURIComponent(id)}?offset=${offset}`, 'GET', undefined, signal))
      if (typeof row.logs !== 'string' || !Number.isSafeInteger(row.nextOffset) || Number(row.nextOffset) < 0) throw new Error('维护日志响应无效')
      return { task: parsePanelTask(row.task), logs: row.logs, nextOffset: row.nextOffset, hasMore: row.hasMore === true } as PanelTaskReport
    },
    async taskByRequest(requestId, signal) {
      try { return parsePanelTask(await request(`${base}/tasks/by-request/${encodeURIComponent(requestId)}`, 'GET', undefined, signal)) }
      catch (cause) { if (cause instanceof PanelHttpError && cause.status === 404) return null; throw cause }
    },
    async ready(origin, id, signal) {
      const response = await fetch(`${origin}/api/health?maintenanceTask=${encodeURIComponent(id)}`, { credentials: 'omit', cache: 'no-store', signal })
      const row = object(await response.json()); return response.ok && row.ok === true && row.ready === true
    },
  }
}

/**
 * 同源轻量健康探测：断连预算耗尽后探测面板是否恢复（health 端点豁免登录）。
 * 任何失败都回 null——探测本就是「面板可能还不可达」场景下的尝试，不抛错打扰调用方。
 */
export async function probeSameOriginHealth(signal?: AbortSignal): Promise<{ commit: string } | null> {
  const abort = new AbortController()
  const cancel = () => abort.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, 3000)
  let settleAbort: () => void = () => {}
  const interrupted = new Promise<null>((resolve) => { settleAbort = () => resolve(null); abort.signal.addEventListener('abort', settleAbort, { once: true }) })
  if (signal?.aborted) cancel()
  try {
    return await Promise.race([interrupted, (async () => {
      if (abort.signal.aborted) return null
      const response = await fetchWithSession('/api/health', { signal: abort.signal, credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) return null
      const row = object(await response.json())
      if (row.ok !== true) return null
      return { commit: typeof row.commit === 'string' ? row.commit : '' }
    })()])
  } catch {
    return null
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); abort.signal.removeEventListener('abort', settleAbort) }
}
