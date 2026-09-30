import { describe, expect, it } from 'bun:test'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { importPlatformLogs } from './logImport'
import { openLogStore } from './logStore'

async function writeGzipFile(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`
  await pipeline(
    async function* () {
      yield Buffer.from(content, 'utf8')
    },
    createGzip(),
    createWriteStream(tmp, { mode: 0o600 }),
  )
  await rename(tmp, path)
}

describe('importPlatformLogs', () => {
  it('导入分片、跳过坏行、忽略非分片，重复导入幂等，读失败留下目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'elysian-log-import-'))
    const platformLogsDir = join(root, 'platform')
    await mkdir(join(platformLogsDir, 'runtime'), { recursive: true })
    await mkdir(join(platformLogsDir, 'operation'), { recursive: true })
    await mkdir(join(platformLogsDir, 'login'), { recursive: true })

    const runtimeLine = JSON.stringify({
      at: '2026-09-23T03:25:10.001Z',
      seq: 1,
      level: 'info',
      source: 'server.lifecycle',
      message: 'panel ready',
    })
    const runtimeShard = join(platformLogsDir, 'runtime', 'runtime-20260923T032510Z.jsonl')
    await writeFile(runtimeShard, `${runtimeLine}\n不是 JSON\n`, 'utf8')

    const operationLine = JSON.stringify({
      at: '2026-09-23T03:25:10.004Z',
      seq: 7,
      category: 'security',
      action: '修改 SSH 监听端口',
      target: 'sshd',
      result: 'success',
      httpStatus: 200,
      method: 'PUT',
      path: '/api/security/ssh/port',
      summary: '端口 2222',
      actor: 'panel',
    })
    const operationShard = join(
      platformLogsDir,
      'operation',
      'operation-20260923T032510Z.jsonl',
    )
    await writeFile(operationShard, `${operationLine}\n`, 'utf8')

    const loginIp = '203.0.113.44'
    const loginLine = JSON.stringify({
      at: '2026-09-23T03:25:10.002Z',
      seq: 3,
      ip: loginIp,
      location: '内网',
      userAgent: 'ElysianTest/1.0',
      status: 'success',
    })
    const loginShard = join(platformLogsDir, 'login', 'login-20260923T032510Z.jsonl.gz')
    await writeGzipFile(loginShard, `${loginLine}\n`)

    const notesPath = join(platformLogsDir, 'runtime', 'notes.txt')
    await writeFile(notesPath, 'keep me\n', 'utf8')
    const sshdPath = join(root, 'sshd.log')
    await writeFile(sshdPath, 'sshd leftover\n', 'utf8')

    const store = openLogStore(join(root, 'logs.sqlite'))
    await importPlatformLogs(store, platformLogsDir)

    expect(store.queryOperation({}).total).toBe(1)
    const op = store.queryOperation({}).entries[0]!
    expect(op).not.toHaveProperty('actor')
    expect(op.action).toBe('修改 SSH 监听端口')

    await importPlatformLogs(store, platformLogsDir)
    expect(store.queryOperation({}).total).toBe(1)

    expect(await readdir(join(platformLogsDir, 'runtime'))).toEqual(['notes.txt'])
    expect(await readdir(join(platformLogsDir, 'operation'))).toEqual([])
    expect(await readdir(root)).toContain('sshd.log')

    const loginHit = store.queryLogin({ q: loginIp })
    expect(loginHit.total).toBe(1)
    expect(loginHit.entries[0]?.ip).toBe(loginIp)

    expect(store.queryRuntime({}).total).toBe(1)

    const fakeShardDir = join(platformLogsDir, 'runtime', 'runtime-20260923T040000Z.jsonl')
    await mkdir(fakeShardDir)
    await expect(importPlatformLogs(store, platformLogsDir)).resolves.toBeUndefined()
    expect(await readdir(join(platformLogsDir, 'runtime'))).toContain('runtime-20260923T040000Z.jsonl')
    expect(await readdir(join(platformLogsDir, 'runtime'))).toContain('notes.txt')

    store.close()
    await rm(root, { recursive: true, force: true })
  })
})
