import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, chown, lstat, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DatabaseInstance } from '@elysian/contracts'
import { ELYSIAN_CONFIG_DIR, ELYSIAN_DATA_DIR } from '../shared/elysianPaths.ts'
import { InvalidRequestError } from '../shared/errors.ts'
import type { DatabaseSession } from './databaseProtocol.ts'

export const SQLITE_UPLOAD_LIMIT = 256 * 1024 ** 2
const SQLITE_FILE_LIMIT = 1024 ** 3
const SQLITE_TOTAL_LIMIT = 4 * 1024 ** 3
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEADER = Buffer.from('SQLite format 3\0')

export type SqliteRecord = {
  id: string
  name: string
  createdAt: string
  state: 'pending' | 'active' | 'deleting'
  origin: 'created' | 'uploaded'
  error?: string
}
export type SqliteService = {
  list(): Promise<DatabaseInstance[]>
  create(name: string): Promise<DatabaseInstance>
  importFile(name: string, request: Request): Promise<DatabaseInstance>
  download(id: string): Promise<{ path: string; name: string; bytes: number; cleanup(): Promise<void> }>
  remove(id: string): Promise<void>
  reconcile(id: string): Promise<DatabaseInstance | undefined>
  forget(id: string): Promise<void>
  openSession(id: string): Promise<DatabaseSession>
}

type WorkerMessage = { id?: number; type?: string; ok?: boolean; value?: unknown; error?: string }
type Worker = { request<T>(kind: 'init' | 'probe' | 'validate' | 'execute' | 'export', extra?: { sql?: string; target?: string; limitBytes?: number }, timeout?: number): Promise<T>; close(): Promise<void> }

async function spawnWorker(file: string, create: boolean, options: { uid?: number; gid?: number; bunBin?: string }): Promise<Worker> {
  const { spawn } = await import('bun')
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  let sequence = 0
  let readyResolve: (() => void) | undefined
  let readyReject: ((error: Error) => void) | undefined
  let closed = false
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const proc = spawn({
    cmd: [options.bunBin ?? process.execPath, new URL('./sqliteWorker.ts', import.meta.url).pathname],
    uid: options.uid, gid: options.gid,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', ELYSIAN_SQLITE_FILE: file, ELYSIAN_SQLITE_CREATE: create ? '1' : '0' },
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    ipc(message: unknown) {
      const frame = message as WorkerMessage
      if (frame.type === 'ready') { readyResolve?.(); readyResolve = undefined; return }
      if (typeof frame.id !== 'number') return
      const task = pending.get(frame.id)
      if (!task) return
      pending.delete(frame.id)
      clearTimeout(task.timer)
      if (frame.ok) task.resolve(frame.value)
      else task.reject(new Error(frame.error ?? 'SQLite 操作失败'))
    },
    onExit() {
      closed = true
      readyReject?.(new Error('SQLite 进程启动失败'))
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('SQLite 会话已中断')) }
      pending.clear()
    },
  })
  const startup = setTimeout(() => { proc.kill(9); readyReject?.(new Error('SQLite 进程启动超时')) }, 5000)
  try { await ready } finally { clearTimeout(startup) }
  return {
    request<T>(kind: 'init' | 'probe' | 'validate' | 'execute' | 'export', extra = {}, timeout = 15_000): Promise<T> {
      if (closed) return Promise.reject(new Error('SQLite 会话已关闭'))
      const id = ++sequence
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          proc.kill(9)
          reject(new Error('SQLite 操作超时，连接已中断'))
        }, timeout)
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
        proc.send({ id, kind, ...extra })
      })
    },
    async close() {
      if (closed) return
      closed = true
      proc.kill(9)
      await proc.exited
    },
  }
}

function validName(value: unknown): string {
  if (typeof value !== 'string' || !NAME.test(value) || value === '.' || value === '..') throw new InvalidRequestError(400, 'SQLite 数据库名无效')
  return value
}

export function createSqliteService(options: {
  dataDir?: string
  registryPath?: string
  uid?: number
  gid?: number
  bunBin?: string
  queryTimeoutMs?: number
  /** 测试注入；生产始终使用 4 GiB。 */
  totalLimitBytes?: number
} = {}): SqliteService {
  const dataDir = options.dataDir ?? join(ELYSIAN_DATA_DIR, 'sqlite')
  const registryPath = options.registryPath ?? join(ELYSIAN_CONFIG_DIR, 'sqlite-databases.json')
  const totalLimit = options.totalLimitBytes ?? SQLITE_TOTAL_LIMIT
  const active = new Map<string, Set<Worker>>()
  let tail: Promise<unknown> = Promise.resolve()
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work)
    tail = run.catch(() => undefined)
    return run
  }

  async function directory(): Promise<string> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const folder = await realpath(dataDir)
    const info = await lstat(folder)
    if (!info.isDirectory()) throw new Error('SQLite 管理目录无效')
    await chmod(folder, 0o700)
    if (options.uid !== undefined && options.gid !== undefined) await chown(folder, options.uid, options.gid)
    return folder
  }

  async function records(): Promise<SqliteRecord[]> {
    let handle
    try { handle = await open(registryPath, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > 1024 * 1024 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('SQLite 登记文件权限无效')
      const parsed: unknown = JSON.parse(await handle.readFile({ encoding: 'utf8' }))
      if (!Array.isArray(parsed) || parsed.some((row) => !row || typeof row !== 'object' || !UUID.test(row.id) || !NAME.test(row.name) || !['pending', 'active', 'deleting'].includes(row.state))) throw new Error('SQLite 登记内容无效')
      return parsed as SqliteRecord[]
    } finally { await handle.close() }
  }

  async function save(rows: SqliteRecord[]): Promise<void> {
    await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 })
    const temp = `${registryPath}.${randomUUID()}.tmp`
    const handle = await open(temp, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(rows)); await handle.sync() } finally { await handle.close() }
    try { await rename(temp, registryPath) } catch (error) { await unlink(temp).catch(() => undefined); throw error }
  }

  async function pathFor(id: string): Promise<string> {
    if (!UUID.test(id)) throw new InvalidRequestError(404, 'SQLite 数据库不存在')
    return join(await directory(), `${id}.db`)
  }

  async function checkedFile(id: string): Promise<string> {
    const path = await pathFor(id)
    const info = await lstat(path)
    if (!info.isFile() || info.nlink !== 1 || info.size > SQLITE_FILE_LIMIT || (info.mode & 0o077) !== 0 || (options.uid !== undefined && info.uid !== options.uid) || dirname(await realpath(path)) !== await directory()) {
      throw new Error('SQLite 文件权限、类型或位置无效')
    }
    return path
  }

  async function ownFile(path: string) {
    await chmod(path, 0o600)
    if (options.uid !== undefined && options.gid !== undefined) await chown(path, options.uid, options.gid)
  }

  async function oneShot<T>(path: string, kind: 'init' | 'probe' | 'validate' | 'export', extra?: { target?: string }, create = false, timeout = 15_000): Promise<T> {
    const worker = await spawnWorker(path, create, options)
    try { return await worker.request<T>(kind, extra, timeout) } finally { await worker.close() }
  }

  async function get(id: string): Promise<SqliteRecord> {
    const row = (await records()).find((item) => item.id === id)
    if (!row) throw new InvalidRequestError(404, 'SQLite 数据库不存在')
    return row
  }

  async function project(row: SqliteRecord): Promise<DatabaseInstance> {
    let status: DatabaseInstance['status'] = 'running'
    let metricsError = row.error
    let fileSizeMb: number | undefined
    let tableCount: number | undefined
    let version = 'SQLite'
    let lastWrittenAt: string | undefined
    const filePath = await pathFor(row.id)
    try {
      const checked = await checkedFile(row.id)
      const [info, sample] = await Promise.all([stat(checked), oneShot<{ tableCount: number; version: string }>(checked, 'probe')])
      fileSizeMb = info.size / 1024 ** 2
      tableCount = sample.tableCount
      version = sample.version
      lastWrittenAt = info.mtime.toISOString()
    } catch (error) {
      status = 'stopped'
      metricsError = error instanceof Error ? error.message : 'SQLite 文件不可用'
    }
    if (row.state !== 'active') { status = 'warning'; metricsError = row.error ?? 'SQLite 文件操作尚未完成，请重新核对或清理登记' }
    return { id: `sqlite-${row.id}`, engine: 'SQLite', name: row.name, version, status, filePath,
      fileSizeMb, tableCount, lastWrittenAt, updatedAt: lastWrittenAt ?? row.createdAt,
      source: 'managed', metricsError, needsAttention: row.state !== 'active' || status !== 'running' }
  }

  async function reserve(name: string, origin: SqliteRecord['origin']): Promise<SqliteRecord> {
    validName(name)
    const rows = await records()
    if (rows.length >= 32) throw new InvalidRequestError(413, 'SQLite 数据库数量已达 32 个上限')
    if (rows.some((row) => row.name.toLowerCase() === name.toLowerCase())) throw new InvalidRequestError(409, '同名 SQLite 数据库已存在')
    const row: SqliteRecord = { id: randomUUID(), name, origin, state: 'pending', createdAt: new Date().toISOString() }
    await save([...rows, row])
    return row
  }

  async function change(row: SqliteRecord) {
    await save((await records()).map((item) => item.id === row.id ? row : item))
  }

  async function totalBytes(): Promise<number> {
    let total = 0
    for (const row of await records()) {
      const file = await pathFor(row.id)
      for (const path of [file, `${file}.upload`]) {
        try { total += (await lstat(path)).size } catch { /* 缺失文件交由核对处理。 */ }
      }
    }
    return total
  }

  async function removeFiles(id: string) {
    const file = await pathFor(id)
    for (const path of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`, `${file}.upload`]) {
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.nlink !== 1) throw new Error('SQLite 文件类型无效，无法自动删除')
        await unlink(path)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }

  async function validateHeader(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const header = Buffer.alloc(20)
    try { await handle.read(header, 0, header.length, 0) } finally { await handle.close() }
    if (!header.subarray(0, HEADER.length).equals(HEADER)) throw new InvalidRequestError(400, '上传文件不是 SQLite 数据库')
    if (header[18] === 2 || header[19] === 2) throw new InvalidRequestError(400, 'WAL 数据库请先导出独立快照再上传')
  }

  return {
    async list() {
      const rows = await records()
      const output = new Array<DatabaseInstance>(rows.length)
      let next = 0
      await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
        for (;;) {
          const index = next++
          if (index >= rows.length) return
          output[index] = await project(rows[index]!)
        }
      }))
      return output
    },
    create(name) { return serialized(async () => {
      if (await totalBytes() >= totalLimit) throw new InvalidRequestError(413, 'SQLite 托管空间已达 4 GiB 上限')
      const row = await reserve(name, 'created')
      const file = await pathFor(row.id)
      try {
        const handle = await open(file, 'wx', 0o600)
        await handle.close()
        await ownFile(file)
        await oneShot(file, 'init', undefined, true)
        if (await totalBytes() > totalLimit) {
          await removeFiles(row.id)
          throw new InvalidRequestError(413, 'SQLite 托管空间超过 4 GiB')
        }
        row.state = 'active'; await change(row)
        return project(row)
      } catch (error) { row.error = error instanceof Error ? error.message : '创建失败'; await change(row); throw error }
    }) },
    importFile(name, request) { return serialized(async () => {
      validName(name)
      if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/octet-stream')) throw new InvalidRequestError(415, '上传类型必须为 application/octet-stream')
      const declared = Number(request.headers.get('content-length'))
      if (declared > SQLITE_UPLOAD_LIMIT) throw new InvalidRequestError(413, 'SQLite 文件超过 256 MiB')
      if (!request.body) throw new InvalidRequestError(400, '上传文件不能为空')
      if ((await totalBytes()) + Math.max(0, declared) > totalLimit) throw new InvalidRequestError(413, 'SQLite 托管空间超过 4 GiB')
      const baseline = await totalBytes()
      const row = await reserve(name, 'uploaded')
      const file = await pathFor(row.id)
      const staging = `${file}.upload`
      let handle
      try {
        handle = await open(staging, 'wx', 0o600)
        const reader = request.body.getReader()
        let bytes = 0
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.byteLength
            if (bytes > SQLITE_UPLOAD_LIMIT || bytes > SQLITE_FILE_LIMIT || baseline + bytes > totalLimit) throw new InvalidRequestError(413, 'SQLite 上传超过空间上限')
            await handle.writeFile(value)
          }
        } finally { await reader.cancel().catch(() => undefined) }
        await handle.sync(); await handle.close(); handle = undefined
        if (bytes < 100 || (declared > 0 && declared !== bytes)) throw new InvalidRequestError(400, 'SQLite 文件为空或上传不完整')
        await validateHeader(staging)
        await ownFile(staging)
        await oneShot(staging, 'validate', undefined, false, 60_000)
        await rename(staging, file)
        row.state = 'active'; row.error = undefined; await change(row)
        return project(row)
      } catch (error) {
        await handle?.close().catch(() => undefined)
        await unlink(staging).catch(() => undefined)
        row.error = error instanceof Error ? error.message : '上传失败'
        await change(row)
        throw error
      }
    }) },
    async download(id) {
      const row = await get(id)
      if (row.state !== 'active') throw new InvalidRequestError(409, 'SQLite 文件尚未就绪')
      const file = await checkedFile(id)
      const target = join(await directory(), `.${id}.${randomUUID()}.export`)
      try {
        const result = await oneShot<{ bytes: number }>(file, 'export', { target }, false, 60_000)
        return { path: target, name: `${row.name}.db`, bytes: result.bytes, cleanup: () => unlink(target).catch(() => undefined) }
      } catch (error) { await unlink(target).catch(() => undefined); throw error }
    },
    remove(id) { return serialized(async () => {
      const row = await get(id)
      row.state = 'deleting'; await change(row)
      for (const worker of active.get(id) ?? []) await worker.close()
      active.delete(id)
      try { await removeFiles(id); await save((await records()).filter((item) => item.id !== id)) }
      catch (error) { row.error = error instanceof Error ? error.message : '删除失败'; await change(row); throw error }
    }) },
    reconcile(id) { return serialized(async () => {
      const row = await get(id)
      if (row.state === 'deleting') { await removeFiles(id); await save((await records()).filter((item) => item.id !== id)); return undefined }
      const file = await pathFor(id)
      const staging = `${file}.upload`
      try {
        try { await lstat(file) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          await validateHeader(staging)
          await ownFile(staging)
          await oneShot(staging, 'validate', undefined, false, 60_000)
          await rename(staging, file)
        }
        await checkedFile(id)
        await oneShot(file, 'validate', undefined, false, 60_000)
        row.state = 'active'; row.error = undefined; await change(row)
        return project(row)
      } catch (error) { row.state = 'pending'; row.error = error instanceof Error ? error.message : '核对失败'; await change(row); throw error }
    }) },
    forget(id) { return serialized(async () => {
      const row = await get(id)
      if (row.state === 'active' && (await project(row)).status === 'running') throw new InvalidRequestError(409, '必须先删除 SQLite 文件')
      await removeFiles(id)
      await save((await records()).filter((item) => item.id !== id))
    }) },
    async openSession(id) {
      const row = await get(id)
      if (row.state !== 'active') throw new InvalidRequestError(409, 'SQLite 文件尚未就绪')
      const worker = await spawnWorker(await checkedFile(id), false, options)
      let set = active.get(id)
      if (!set) { set = new Set(); active.set(id, set) }
      set.add(worker)
      return {
        execute: (input) => serialized(async () => {
          const file = await checkedFile(id)
          const ownBytes = (await stat(file)).size
          const others = (await totalBytes()) - ownBytes
          const limitBytes = Math.max(ownBytes, Math.min(SQLITE_FILE_LIMIT, totalLimit - others))
          return worker.request<string[]>('execute', { sql: input, limitBytes }, options.queryTimeoutMs ?? 15_000)
        }),
        close: async () => { await worker.close(); set!.delete(worker) },
      }
    },
  }
}
