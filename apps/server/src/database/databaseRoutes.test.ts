import { describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from './databaseService.ts'
import { createDatabaseApp } from './databaseRoutes.ts'
import type { DatabaseInstance } from '@elysian/contracts'
import type { SqliteService } from './sqliteService.ts'

const ID = 'db-1'
const secret = { username: 'reader', password: 'password-hidden-from-list' }
function fixture() {
  const instance: DatabaseInstance = { id: ID, engine: 'MySQL', name: 'orders', version: '8.4', status: 'running', updatedAt: '2026-09-28T00:00:00.000Z', hasCredentials: true, credentialUsername: secret.username }
  const service: DatabaseService = {
    list: vi.fn(async () => [instance]),
    discover: vi.fn(async () => ({ images: [], containers: [] })),
    create: vi.fn(async () => instance),
    reveal: vi.fn(async () => secret),
    remove: vi.fn(async () => undefined),
    removeContainer: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => instance),
    forget: vi.fn(async () => undefined),
    openSession: vi.fn(async () => ({ execute: async () => [], close: async () => undefined })),
  }
  const app = createDatabaseApp({ available: true, service })
  return { app, service }
}

describe('数据库 HTTP 守卫', () => {
  it('列表没有密码，按需凭证禁止缓存且跨源请求被拒', async () => {
    const { app } = fixture()
    const listed = await app.request('http://localhost:48100/')
    expect(await listed.text()).not.toContain(secret.password)
    const blocked = await app.request('http://localhost:48100/db-1/reveal', { method: 'POST', headers: { Host: 'localhost:48100', Origin: 'http://evil.example' } })
    expect(blocked.status).toBe(403)
    const revealed = await app.request('http://localhost:48100/db-1/reveal', { method: 'POST', headers: { Host: 'localhost:48100', Origin: 'http://localhost:48100' } })
    expect(revealed.headers.get('cache-control')).toBe('no-store')
    expect(await revealed.json()).toEqual(secret)
  })

  it('容器和卷删除需要确认正文，终端升级要求同源', async () => {
    const { app, service } = fixture()
    const headers = { Host: 'localhost:48100', Origin: 'http://localhost:48100', 'Content-Type': 'application/json' }
    const denied = await app.request('http://localhost:48100/db-1/container', { method: 'DELETE', headers, body: JSON.stringify({ confirm: false }) })
    expect(denied.status).toBe(400)
    expect(service.removeContainer).not.toHaveBeenCalled()
    const accepted = await app.request('http://localhost:48100/db-1/container', { method: 'DELETE', headers, body: JSON.stringify({ confirm: 'DELETE_CONTAINER_AND_DATA' }) })
    expect(accepted.status).toBe(200)
    const wsDenied = await app.request('http://localhost:48100/db-1/terminal', { headers: { Host: 'localhost:48100', Origin: 'http://evil.example' } })
    expect(wsDenied.status).toBe(403)
  })
})

it('SQLite 文件路由分别处理创建、上传、删除确认与列表', async () => {
  const { service } = fixture()
  const sqlite: DatabaseInstance = { id: 'sqlite-123', engine: 'SQLite', name: 'notes', version: '3.54', status: 'running', filePath: '/managed/123.db', updatedAt: '2026-09-28T00:00:00.000Z', source: 'managed' }
  const files: SqliteService = {
    list: vi.fn(async () => [sqlite]), create: vi.fn(async () => sqlite), importFile: vi.fn(async () => sqlite),
    download: vi.fn(), remove: vi.fn(async () => undefined), reconcile: vi.fn(async () => sqlite),
    forget: vi.fn(async () => undefined), openSession: vi.fn(),
  }
  const app = createDatabaseApp({ available: true, service, sqlite: files })
  const headers = { Host: 'localhost:48100', Origin: 'http://localhost:48100', 'Content-Type': 'application/json' }
  const list = await app.request('http://localhost:48100/')
  expect((await list.json() as DatabaseInstance[]).map((row) => row.engine)).toEqual(['MySQL', 'SQLite'])
  const created = await app.request('http://localhost:48100/sqlite', { method: 'POST', headers, body: JSON.stringify({ name: 'notes' }) })
  expect(created.status).toBe(201)
  expect(files.create).toHaveBeenCalledWith('notes')
  const upload = await app.request('http://localhost:48100/sqlite/import?name=copy', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: 'bytes' })
  expect(upload.status).toBe(201)
  expect(files.importFile).toHaveBeenCalledWith('copy', expect.any(Request))
  const denied = await app.request('http://localhost:48100/sqlite/sqlite-123', { method: 'DELETE', headers, body: JSON.stringify({ confirm: false }) })
  expect(denied.status).toBe(400)
  expect(files.remove).not.toHaveBeenCalled()
  const removed = await app.request('http://localhost:48100/sqlite/sqlite-123', { method: 'DELETE', headers, body: JSON.stringify({ confirm: 'DELETE_SQLITE_FILE' }) })
  expect(removed.status).toBe(200)
  expect(files.remove).toHaveBeenCalledWith('123')
})
