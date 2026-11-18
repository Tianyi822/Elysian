import { withRequestDeadline } from './requestDeadline'
import type { DatabaseContainerInstance, DatabaseInstance } from '@elysian/contracts'
import type { DatabaseAdapter, DatabaseCreateInput, DatabaseCreateResult } from '../../contracts/adapters'
import { captureAuthGeneration } from '../../utils/authGeneration'
import { fetchWithSession, reportUnauthorized, reportUnauthorizedStatus } from './unauthorized'
import { parseFirewallPortSync } from './firewallHttpAdapter'

const BASE = '/api/databases'

/** 从 Content-Disposition 解析文件名（attachment; filename="xxx.sqlite"）；缺失或畸形时回退到 id。 */
export function sqliteDownloadName(disposition: string | null, fallbackId: string): string {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition ?? '')
  return match?.[1]?.trim() || `${fallbackId}.sqlite`
}

function request<T>(path: string, init?: RequestInit): Promise<T> {
  return withRequestDeadline(init, (bounded) => readJson<T>(path, bounded), init?.method === 'POST' && path === '/' ? 30 * 60_000 : undefined)
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithSession(`${BASE}${path}`, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    cache: 'no-store',
  })
  const body = await response.json() as T & { error?: string }
  if (!response.ok) {
    if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
    throw new Error(body.error ?? `数据库请求失败（${response.status}）`)
  }
  return body
}

export function createHttpDatabaseAdapter(): DatabaseAdapter {
  return {
    list: () => request<DatabaseContainerInstance[]>('/'),
    listSqlite: () => request<DatabaseInstance[]>('/sqlite'),
    async create(input: DatabaseCreateInput, onProgress): Promise<DatabaseCreateResult> {
      if (input.kind === 'file') {
        if (input.origin === 'created') return { instance: await request<DatabaseInstance>('/sqlite', { method: 'POST', body: JSON.stringify({ name: input.name }) }), firewallPort: null }
        if (!input.file) throw new Error('请选择实际 SQLite 文件')
        const instance = await new Promise<DatabaseInstance>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          const generation = captureAuthGeneration()
          xhr.open('POST', `${BASE}/sqlite/import?name=${encodeURIComponent(input.name)}`)
          xhr.setRequestHeader('Content-Type', 'application/octet-stream')
          xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100)) }
          xhr.onerror = () => reject(new Error('SQLite 文件上传失败'))
          xhr.onload = () => {
            let body: DatabaseInstance & { error?: string }
            try { body = JSON.parse(xhr.responseText) as typeof body } catch { reject(new Error('SQLite 上传响应无效')); return }
            if (xhr.status < 200 || xhr.status >= 300) {
              // 会话过期：按状态号上报（XHR 拿不到 Response 对象），错误不透传 HTTP 401。
              if (reportUnauthorizedStatus(xhr.status, generation)) reject(new Error('登录状态已失效，请重新登录'))
              else reject(new Error(body.error ?? 'SQLite 文件上传失败'))
            }
            else resolve(body)
          }
          xhr.send(input.file)
        })
        return { instance, firewallPort: null }
      }
      if (!input.versionTag || !input.imageId) throw new Error('请选择数据库镜像版本')
      const body = await request<{ instance: DatabaseContainerInstance; firewallPort: unknown }>('/', { method: 'POST', body: JSON.stringify({
        engine: input.engine, versionTag: input.versionTag, containerName: input.containerName, imageId: input.imageId,
        accessScope: input.accessScope, hostPort: input.hostPort, confirmPublic: input.confirmPublic,
      }) })
      return { instance: body.instance, firewallPort: parseFirewallPortSync(body.firewallPort ?? null) }
    },
    async removeSqlite(id) {
      await request(`/sqlite/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE_SQLITE_FILE' }) })
    },
    async removeContainer(id) {
      await request(`/${encodeURIComponent(id)}/container`, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE_CONTAINER_AND_DATA' }) })
    },
    reveal: (id) => request(`/${encodeURIComponent(id)}/reveal`, { method: 'POST' }),
    reconcile: (id) => request(`/${encodeURIComponent(id)}/reconcile`, { method: 'POST' }),
    reconcileSqlite: (id) => request(`/sqlite/${encodeURIComponent(id)}/reconcile`, { method: 'POST' }),
    async forget(id) { await request(`/${encodeURIComponent(id)}/registration`, { method: 'DELETE' }) },
    async forgetSqlite(id) { await request(`/sqlite/${encodeURIComponent(id)}/registration`, { method: 'DELETE' }) },
    /**
     * 下载一致性 SQLite 快照。用 fetch 取 blob 触发下载而不是 `<a href>` 导航：
     * 导航下载够不到 401 拦截，会话过期时会把错误 JSON 当文件保存；演示文件很小，
     * blob 常驻内存可忽略，换回「401 有明确中文反馈」。
     */
    async downloadSqlite(id) {
      const auth = captureAuthGeneration()
      const url = `${BASE}/sqlite/${encodeURIComponent(id)}/download`
      let response: Response
      try {
        response = await fetchWithSession(url)
      } catch {
        throw new Error('SQLite 下载失败：面板服务不可达')
      }
      if (!response.ok) {
        if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
        throw new Error('SQLite 下载失败')
      }
      const blob = await response.blob()
      if (auth !== captureAuthGeneration()) throw new Error('登录状态已变更，请重新下载')
      const objectUrl = URL.createObjectURL(blob)
      try {
        const link = document.createElement('a')
        link.href = objectUrl
        link.download = sqliteDownloadName(response.headers.get('Content-Disposition'), id)
        document.body.append(link)
        link.click()
        link.remove()
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
    },
  }
}
