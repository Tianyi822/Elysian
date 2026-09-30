import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogsHostDeps } from './logsHostDeps'

const operationLine = JSON.stringify({
  at: '2026-09-23T03:15:00.004Z',
  seq: 7,
  category: 'security',
  action: '修改 SSH 监听端口',
  target: 'sshd',
  result: 'success',
  httpStatus: 200,
  method: 'PUT',
  path: '/api/security/ssh/port',
  summary: '端口 2222',
})

describe('createLogsHostDeps', () => {
  it('打开库、导入已有分片，之后 recordOperation 能从 operationLog 读回', async () => {
    const root = await mkdtemp(join(tmpdir(), 'elysian-host-'))
    try {
      const platform = join(root, 'platform')
      await mkdir(join(platform, 'operation'), { recursive: true })
      await writeFile(join(platform, 'operation', 'operation-20260923T031500Z.jsonl'), `${operationLine}\n`)
      await writeFile(join(root, 'sshd.log'), 'sshd stays')
      const { service } = await createLogsHostDeps({
        platformLogsDir: platform,
        logsSqlitePath: join(root, 'logs.sqlite'),
        now: () => new Date('2026-09-30T00:00:00.000Z'),
      })
      expect(await readdir(join(platform, 'operation'))).toEqual([])
      expect(readFileSync(join(root, 'sshd.log'), 'utf8')).toBe('sshd stays')
      const report = await service.operationLog({})
      expect(report.total).toBe(1)
      await service.recordOperation({ category: 'logs', action: '清空运行日志', result: 'success' })
      expect((await service.operationLog({})).total).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('库路径的父目录不是目录时仍返回服务，查询抛日志数据库不可用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'elysian-host-'))
    try {
      const blocker = join(root, 'not-a-dir')
      await writeFile(blocker, 'x')
      const { service } = await createLogsHostDeps({
        platformLogsDir: join(root, 'platform'),
        logsSqlitePath: join(blocker, 'logs.sqlite'),
      })
      await expect(service.runtimeLog({})).rejects.toThrow('日志数据库不可用')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
