import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteService, SQLITE_UPLOAD_LIMIT } from './sqliteService.ts'

const paths: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'elysian-sqlite-'))
  paths.push(root)
  const dataDir = join(root, 'data')
  const registryPath = join(root, 'registry.json')
  return { root, dataDir, registryPath, service: createSqliteService({ dataDir, registryPath }) }
}
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

test('SQLite 文件、终端、快照下载与删除在重启后保持一致', async () => {
  const { dataDir, registryPath, service } = await fixture()
  const created = await service.create('notes')
  expect(created.status).toBe('running')
  expect(created.tableCount).toBe(0)
  const session = await service.openSession(created.id.slice(7))
  expect(await session.execute('CREATE TABLE notes (id INTEGER, value TEXT)')).toContain('执行成功，影响 0 行。')
  await session.execute("INSERT INTO notes VALUES (1, '保留数据')")
  expect(await session.execute('SELECT value FROM notes')).toContain('保留数据')
  expect(session.execute("ATTACH DATABASE '/etc/passwd' AS x")).rejects.toThrow('禁止文件')
  await session.close()
  const restarted = createSqliteService({ dataDir, registryPath })
  expect((await restarted.list())[0]?.tableCount).toBe(1)
  const snapshot = await restarted.download(created.id.slice(7))
  expect(snapshot.bytes).toBeGreaterThan(0)
  const file = Buffer.from(await readFile(snapshot.path))
  await snapshot.cleanup()
  const imported = await restarted.importFile('copy', new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }))
  expect(imported.tableCount).toBe(1)
  await restarted.remove(created.id.slice(7))
  expect((await restarted.list()).map((row) => row.name)).toEqual(['copy'])
})

test('上传拒绝损坏文件、单独 WAL 主文件和超限声明，失败保持可清理状态', async () => {
  const { service } = await fixture()
  const upload = (name: string, bytes: Buffer) => service.importFile(name, new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }))
  expect(upload('bad', Buffer.alloc(200))).rejects.toThrow('不是 SQLite')
  const pending = (await service.list()).find((row) => row.name === 'bad')
  expect(pending?.needsAttention).toBe(true)
  await service.forget(pending!.id.slice(7))
  const valid = await service.create('source')
  const snapshot = await service.download(valid.id.slice(7))
  const wal = Buffer.from(await readFile(snapshot.path))
  await snapshot.cleanup()
  wal[18] = 2; wal[19] = 2
  expect(upload('wal', wal)).rejects.toThrow('WAL')
  const oversized = new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(SQLITE_UPLOAD_LIMIT + 1) }, body: Buffer.from('x') })
  expect(service.importFile('oversized', oversized)).rejects.toThrow('256 MiB')
})

test('受管文件被替换为符号链接后不可连接，清理不跟随链接', async () => {
  const { root, service } = await fixture()
  const row = await service.create('guard')
  const outside = join(root, 'outside.db')
  await writeFile(outside, '不得删除')
  await rm(row.filePath!)
  await symlink(outside, row.filePath!)
  expect((await service.list())[0]?.status).toBe('stopped')
  expect(service.openSession(row.id.slice(7))).rejects.toThrow('文件权限')
  expect(service.forget(row.id.slice(7))).rejects.toThrow('文件类型')
  expect(await readFile(outside, 'utf8')).toBe('不得删除')
})

test('结果逐行截断，长查询到时终止独立进程', async () => {
  const { dataDir, registryPath, service } = await fixture()
  const row = await service.create('limits')
  const bounded = createSqliteService({ dataDir, registryPath, queryTimeoutMs: 100 })
  const session = await bounded.openSession(row.id.slice(7))
  const lines = await session.execute('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 700) SELECT x FROM n')
  expect(lines.some((line) => line.includes('500 行上限'))).toBe(true)
  expect((await session.execute('SELECT hex(zeroblob(600000)) AS data')).some((line) => line.includes('单元格超过 1 MiB'))).toBe(true)
  await expect(session.execute('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 1000000000) SELECT sum(x) FROM n')).rejects.toThrow('超时')
  await session.close()
  const after = await service.openSession(row.id.slice(7))
  expect(await after.execute('SELECT 1')).toContain('1')
  await after.close()
})

test('终端写入遵守托管总量约束，超限后文件不继续增长', async () => {
  const { dataDir, registryPath } = await fixture()
  const service = createSqliteService({ dataDir, registryPath, totalLimitBytes: 8192 })
  const row = await service.create('quota')
  const session = await service.openSession(row.id.slice(7))
  await session.execute('CREATE TABLE quota (value BLOB)')
  await expect(session.execute('INSERT INTO quota VALUES (zeroblob(20000))')).rejects.toThrow()
  await session.close()
  expect((await stat(row.filePath!)).size).toBeLessThanOrEqual(8192)
  await expect(service.create('second')).rejects.toThrow('上限')
})
