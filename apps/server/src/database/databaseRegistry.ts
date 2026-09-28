import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { DatabaseEngine } from '@elysian/contracts'
import { ELYSIAN_CONFIG_DIR } from '../shared/elysianPaths.ts'

export type DatabaseSecret = { username: string; password: string }
export type DatabaseRecord = {
  id: string
  engine: Exclude<DatabaseEngine, 'SQLite'>
  name: string
  versionTag: string
  containerId: string
  volumeName?: string
  source: 'managed' | 'adopted'
  accessScope: 'localhost' | 'container-network' | 'any-host'
  admin: DatabaseSecret
  user: DatabaseSecret
  createdAt: string
  state: 'active' | 'needs-attention' | 'empty'
}

export interface DatabaseRegistry {
  list(): Promise<readonly DatabaseRecord[]>
  put(record: DatabaseRecord): Promise<void>
  remove(id: string): Promise<void>
}

const REGISTRY_PATH = join(ELYSIAN_CONFIG_DIR, 'databases.json')

/** 凭证与资源登记同一笔原子替换；文件只允许本机服务进程读取。 */
export function createFileDatabaseRegistry(path = REGISTRY_PATH): DatabaseRegistry {
  let tail: Promise<unknown> = Promise.resolve()

  async function read(): Promise<DatabaseRecord[]> {
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('数据库登记文件权限或内容无效')
      const value: unknown = JSON.parse(await handle.readFile({ encoding: 'utf8' }))
      if (!Array.isArray(value)) throw new Error('数据库登记文件无效')
      // 文件是本进程写出的私有数据；不向浏览器透传其原始内容。
      return value as DatabaseRecord[]
    } finally {
      await handle.close()
    }
  }

  async function write(records: readonly DatabaseRecord[]): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(records))
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  function update(change: (rows: DatabaseRecord[]) => DatabaseRecord[]): Promise<void> {
    const run = tail.then(async () => write(change(await read())))
    tail = run.catch(() => undefined)
    return run
  }

  return {
    list: () => tail.then(read),
    put: (record) => update((rows) => [...rows.filter((row) => row.id !== record.id), record]),
    remove: (id) => update((rows) => rows.filter((row) => row.id !== id)),
  }
}

export function createMemoryDatabaseRegistry(seed: readonly DatabaseRecord[] = []): DatabaseRegistry {
  let rows = [...seed]
  return {
    async list() { return rows.map((row) => ({ ...row })) },
    async put(record) { rows = [...rows.filter((row) => row.id !== record.id), { ...record }] },
    async remove(id) { rows = rows.filter((row) => row.id !== id) },
  }
}
