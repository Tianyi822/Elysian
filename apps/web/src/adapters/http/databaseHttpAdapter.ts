import { withRequestDeadline } from './requestDeadline'
import type { DatabaseInstance, DatabaseEngine, ContainerImage } from '@elysian/contracts'
import type { DatabaseAdapter, DatabaseCreateInput, DatabaseCreateResult } from '../../contracts/adapters'
import { captureAuthGeneration, fetchWithSession, reportUnauthorized, reportUnauthorizedStatus } from './unauthorized'
import { parseFirewallPortSync } from './firewallHttpAdapter'

const BASE = '/api/databases'

/** 从 Content-Disposition 解析文件名（attachment; filename="xxx.sqlite"）；缺失或畸形时回退到 id。 */
export function sqliteDownloadName(disposition: string | null, fallbackId: string): string {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition ?? '')
  return match?.[1]?.trim() || `${fallbackId}.sqlite`
}

function request<T>(path: string, init?: RequestInit): Promise<T> {
  return withRequestDeadline(init, (bounded) => readJson<T>(path, bounded), path.includes("/install") || (init?.method === "POST" && path === "/") ? 30 * 60_000 : undefined)
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

function openTerminal(id: string): Promise<{ execute(input: string): Promise<readonly string[]>; close(): void }> {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}${BASE}/${encodeURIComponent(id)}/terminal`)
  const queue: ((frame: { type: string; text?: string; lines?: string[] }) => void)[] = []
  let closed = false
  let inFlight = false
  socket.onmessage = (event) => {
    try {
      const frame = JSON.parse(String(event.data)) as { type: string; text?: string; lines?: string[] }
      if (frame.type === 'ready') { queue.shift()?.(frame); return }
      queue.shift()?.(frame)
    } catch { /* 畸形服务帧交给等待超时处理。 */ }
  }
  socket.onclose = () => { closed = true; for (const resolve of queue.splice(0)) resolve({ type: 'error', text: '数据库连接已断开' }) }
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('数据库连接超时')) }, 10_000)
    queue.push((frame) => {
      clearTimeout(timer)
      if (frame.type === 'ready') resolve()
      else reject(new Error(frame.text ?? '数据库连接失败'))
    })
  })
  return ready.then(() => ({
    execute(input) {
      if (closed) return Promise.reject(new Error('数据库连接已断开'))
      if (inFlight) return Promise.reject(new Error('上一条数据库命令仍在执行'))
      inFlight = true
      return new Promise<readonly string[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          inFlight = false
          closed = true
          socket.close()
          reject(new Error('数据库操作超时，连接已中断'))
        }, 20_000)
        queue.push((frame) => {
          clearTimeout(timer)
          inFlight = false
          if (frame.type === 'output') resolve(frame.lines ?? [])
          else reject(new Error(frame.text ?? '数据库操作失败'))
        })
        socket.send(JSON.stringify({ type: 'execute', text: input }))
      })
    },
    close() { closed = true; socket.close() },
  }))
}

export function createHttpDatabaseAdapter(): DatabaseAdapter {
  return {
    list: () => request<DatabaseInstance[]>('/'),
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
      if (!input.versionTag || !input.target) throw new Error('请选择数据库版本和容器')
      const body = await request<{ instance: DatabaseInstance; firewallPort: unknown }>('/', { method: 'POST', body: JSON.stringify({
        engine: input.engine, versionTag: input.versionTag,
        name: input.engine === 'Redis' ? '0' : input.name,
        charset: input.charset, user: { username: input.username, password: input.password },
        accessScope: input.accessScope, hostPort: input.hostPort, confirmPublic: input.confirmPublic, target: input.target,
      }) })
      return { instance: body.instance, firewallPort: parseFirewallPortSync(body.firewallPort ?? null) }
    },
    async remove(id) {
      if (id.startsWith('sqlite-')) {
        await request(`/sqlite/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE_SQLITE_FILE' }) })
        return
      }
      await request(`/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    discover(engine: Exclude<DatabaseEngine, 'SQLite'>, versionTag?: string) {
      return request<{ images: readonly ContainerImage[]; containers: readonly { id: string; name: string; accessScope: string; managed: boolean; versionTag: string }[] }>(`/discover?engine=${encodeURIComponent(engine)}${versionTag === undefined ? '' : `&versionTag=${encodeURIComponent(versionTag)}`}`)
    },
    reveal: (id) => request(`/${encodeURIComponent(id)}/reveal`, { method: 'POST' }),
    async removeContainer(id) {
      await request(`/${encodeURIComponent(id)}/container`, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE_CONTAINER_AND_DATA' }) })
    },
    reconcile: (id) => request(`${id.startsWith('sqlite-') ? '/sqlite' : ''}/${encodeURIComponent(id)}/reconcile`, { method: 'POST' }),
    async forget(id) { await request(`${id.startsWith('sqlite-') ? '/sqlite' : ''}/${encodeURIComponent(id)}/registration`, { method: 'DELETE' }) },
    openTerminal,
    /**
     * 下载一致性 SQLite 快照。用 fetch 取 blob 触发下载而不是 `<a href>` 导航：
     * 导航下载够不到 401 拦截，会话过期时会把错误 JSON 当文件保存；演示文件很小，
     * blob 常驻内存可忽略，换回「401 有明确中文反馈」。
     */
    async downloadSqlite(id) {
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
