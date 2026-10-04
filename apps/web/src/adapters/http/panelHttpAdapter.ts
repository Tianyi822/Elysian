import type { PanelCommit, PanelInfo, PanelPorts, PanelTask, PanelTaskReport, PanelUpdate } from '@elysian/contracts'
import { validatePanelPorts } from '@elysian/contracts'
import type { PanelAdapter } from '../../contracts/adapters'
import { reportUnauthorized } from './unauthorized'

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
  return { ...row, oldPorts: ports(row.oldPorts), newPorts: ports(row.newPorts) } as PanelTask
}
export function parsePanelInfo(value: unknown): PanelInfo {
  const row = object(value)
  for (const key of ['commit', 'buildTime', 'repository', 'reason']) if (typeof row[key] !== 'string') throw new Error('面板信息响应无效')
  if (typeof row.available !== 'boolean') throw new Error('面板维护能力响应无效')
  return { ...row, ports: ports(row.ports), activeTask: row.activeTask === null ? null : parsePanelTask(row.activeTask), lastTask: row.lastTask === null ? null : parsePanelTask(row.lastTask) } as PanelInfo
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
async function request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 30000)
  try {
  const response = await fetch(path, { method, signal: abort.signal, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  if (response.status === 401) { reportUnauthorized(response); throw new Error('登录状态已失效，请重新登录') }
  const data: unknown = await response.json()
  if (!response.ok) { const row = object(data); throw new Error(typeof row.error === 'string' ? row.error : `面板维护请求失败：HTTP ${response.status}`) }
  return data
  } catch (cause) {
    if (cause instanceof TypeError || cause instanceof SyntaxError || cause instanceof DOMException) throw new Error('面板连接失败或响应无效，请稍后重试')
    throw cause
  } finally { clearTimeout(timer) }
}
export function createHttpPanelAdapter(base = '/api/panel'): PanelAdapter {
  return {
    info: async () => parsePanelInfo(await request(base)),
    async checkUpdate() {
      const row = object(await request(`${base}/update`))
      for (const key of ['repository', 'branch', 'currentCommit', 'targetCommit', 'message']) if (typeof row[key] !== 'string') throw new Error('更新信息响应无效')
      if (typeof row.available !== 'boolean') throw new Error('更新信息响应无效')
      return row as PanelUpdate
    },
    commits: async () => parsePanelCommits(await request(`${base}/commits`)),
    ports: async (value, requestId) => parsePanelTask(await request(`${base}/ports`, 'PUT', { ...value, requestId })),
    restart: async (requestId) => parsePanelTask(await request(`${base}/restart`, 'POST', { requestId })),
    update: async (targetCommit, requestId) => parsePanelTask(await request(`${base}/update`, 'POST', { targetCommit, requestId })),
    async task(id, offset = 0) {
      const row = object(await request(`${base}/tasks/${encodeURIComponent(id)}?offset=${offset}`))
      if (typeof row.logs !== 'string' || !Number.isSafeInteger(row.nextOffset) || Number(row.nextOffset) < 0) throw new Error('维护日志响应无效')
      return { task: parsePanelTask(row.task), logs: row.logs, nextOffset: row.nextOffset, hasMore: row.hasMore === true } as PanelTaskReport
    },
    async ready(origin, id, signal) {
      const response = await fetch(`${origin}/api/health?maintenanceTask=${encodeURIComponent(id)}`, { credentials: 'omit', cache: 'no-store', signal })
      const row = object(await response.json()); return response.ok && row.ok === true && row.ready === true
    },
  }
}
