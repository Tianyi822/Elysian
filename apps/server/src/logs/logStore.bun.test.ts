import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOG_ENTRY_FETCH_LIMIT } from '@elysian/contracts'
import { LOG_RECORD_MAX_BYTES } from './logRecords'
import { createUnavailableLogStore, openLogStore } from './logStore'

describe('openLogStore', () => {
  it('操作日志按分类与结果筛选，关键字忽略大小写并按字面匹配 %', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'elysian-logs-'))
    const store = openLogStore(join(dir, 'logs.sqlite'))
    store.insertOperation({
      at: '2026-09-23T00:00:02.000Z', category: 'security', action: '修改 SSH 监听端口',
      target: 'sshd', summary: '端口 2222', result: 'success', method: 'PUT',
      path: '/api/security/ssh/port', httpStatus: 200,
    })
    store.insertOperation({
      at: '2026-09-23T00:00:01.000Z', category: 'files', action: '复制文件',
      target: null, summary: '100%_ok', result: 'failure', method: 'POST',
      path: '/api/files/copy', httpStatus: 400,
    })
    const matched = store.queryOperation({ category: 'files', result: 'failure', q: '100%_OK' })
    expect(matched.total).toBe(1)
    expect(matched.entries[0]?.summary).toBe('100%_ok')
    expect(matched.entries[0]?.id).toMatch(/^\d+$/)
    const page = store.queryOperation({ limit: 1 })
    expect(page.total).toBe(2)
    expect(page.truncated).toBe(true)
    const older = store.queryOperation({
      limit: 1,
      before: page.entries[0]!.at,
      beforeId: Number(page.entries[0]!.id),
    })
    expect(older.entries[0]?.action).toBe('复制文件')
    expect(store.counters()).toEqual({ droppedRecords: 0, failedWrites: 0 })
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('同一 sourceKey 只保留一行，超长 message 先截断再写入且不计入 droppedRecords', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'elysian-logs-'))
    const store = openLogStore(join(dir, 'logs.sqlite'))
    store.insertRuntime({
      at: '2026-09-23T00:00:01.000Z',
      level: 'info',
      source: 'server.test',
      message: 'first',
      sourceKey: 'seed:runtime:1',
    })
    store.insertRuntime({
      at: '2026-09-23T00:00:02.000Z',
      level: 'warning',
      source: 'server.test',
      message: 'second',
      sourceKey: 'seed:runtime:1',
    })
    expect(store.queryRuntime({}).total).toBe(1)
    expect(store.queryRuntime({}).entries[0]?.message).toBe('first')
    store.insertRuntime({
      at: '2026-09-23T00:00:03.000Z',
      level: 'error',
      source: 'server.test',
      message: '中'.repeat(LOG_RECORD_MAX_BYTES),
    })
    const page = store.queryRuntime({})
    expect(page.total).toBe(2)
    const truncated = page.entries.find((entry) => entry.at === '2026-09-23T00:00:03.000Z')
    expect(truncated?.message.endsWith('…（已截断）')).toBe(true)
    expect(store.counters()).toEqual({ droppedRecords: 0, failedWrites: 0 })
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('运行与登录日志关键字落在约定字段，登录可按 status 筛选', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'elysian-logs-'))
    const store = openLogStore(join(dir, 'logs.sqlite'))
    store.insertRuntime({
      at: '2026-09-23T00:00:01.000Z',
      level: 'info',
      source: 'server.lifecycle',
      message: 'panel ready',
    })
    store.insertLogin({
      at: '2026-09-23T00:00:01.000Z',
      ip: '203.0.113.10',
      location: '内网',
      userAgent: 'ElysianTest/1.0',
      status: 'success',
    })
    store.insertLogin({
      at: '2026-09-23T00:00:02.000Z',
      ip: '198.51.100.8',
      location: '未知',
      userAgent: 'OtherAgent/2.0',
      status: 'failure',
    })
    expect(store.queryRuntime({ q: 'LIFECYCLE' }).total).toBe(1)
    expect(store.queryRuntime({ q: 'PANEL READY' }).total).toBe(1)
    expect(store.queryRuntime({ q: 'missing' }).total).toBe(0)
    expect(store.queryLogin({ q: '203.0.113.10' }).total).toBe(1)
    expect(store.queryLogin({ q: '内网' }).total).toBe(1)
    expect(store.queryLogin({ q: 'ElysianTest' }).total).toBe(1)
    expect(store.queryLogin({ status: 'failure' }).total).toBe(1)
    expect(store.queryLogin({ status: 'failure' }).entries[0]?.ip).toBe('198.51.100.8')
    expect(store.queryLogin({ status: 'failure' }).entries[0]?.time).toBe('2026-09-23T00:00:02.000Z')
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('limit 超过 LOG_ENTRY_FETCH_LIMIT 时钳到上限', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'elysian-logs-'))
    const store = openLogStore(join(dir, 'logs.sqlite'))
    const total = LOG_ENTRY_FETCH_LIMIT + 3
    const base = Date.UTC(2026, 8, 23)
    for (let i = 0; i < total; i += 1) {
      store.insertRuntime({
        at: new Date(base + i * 1000).toISOString(),
        level: 'info',
        source: 'server.clamp',
        message: `row-${i}`,
      })
    }
    const page = store.queryRuntime({ limit: 5000 })
    expect(page.total).toBe(total)
    expect(page.entries).toHaveLength(LOG_ENTRY_FETCH_LIMIT)
    expect(page.truncated).toBe(true)
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('过期行按时间删除，超预算从最旧的行删', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'elysian-logs-'))
    const store = openLogStore(join(dir, 'logs.sqlite'))
    store.insertRuntime({ at: '2026-09-01T00:00:00.000Z', level: 'info', source: 'a', message: '旧' })
    store.insertRuntime({ at: '2026-09-30T00:00:00.000Z', level: 'info', source: 'a', message: '新' })
    const aged = store.sweep('runtime', new Date('2026-09-30T00:00:00.000Z'))
    expect(aged.deletedByAge).toBe(1)
    expect(store.queryRuntime({}).entries.map((entry) => entry.message)).toEqual(['新'])

    const tight = openLogStore(join(dir, 'budget.sqlite'), {
      runtime: { retentionDays: 7, maxTotalBytes: 1 },
    })
    tight.insertRuntime({ at: '2026-09-29T00:00:00.000Z', level: 'info', source: 'a', message: '旧行' })
    tight.insertRuntime({ at: '2026-09-30T00:00:00.000Z', level: 'info', source: 'a', message: '新行' })
    const sized = tight.sweep('runtime', new Date('2026-09-30T00:00:00.000Z'))
    expect(sized.deletedBySize).toBe(2)
    expect(sized.trimmedBySize).toBe(true)
    expect(sized.totalBytes).toBe(0)
    expect(tight.queryRuntime({}).total).toBe(0)
    store.close()
    tight.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('清空只删除所选类别并返回行数与字节', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'elysian-logs-'))
    const store = openLogStore(join(dir, 'logs.sqlite'))
    store.insertRuntime({ at: '2026-09-30T00:00:00.000Z', level: 'info', source: 'a', message: '运行' })
    store.insertOperation({
      at: '2026-09-30T00:00:01.000Z',
      category: 'files',
      action: '复制文件',
      target: null,
      summary: 'ok',
      result: 'success',
      method: 'POST',
      path: '/api/files/copy',
      httpStatus: 200,
    })
    const cleared = store.clear('operation')
    expect(cleared.rowCount).toBe(1)
    expect(cleared.totalBytes).toBeGreaterThan(0)
    expect(store.queryRuntime({}).total).toBe(1)
    expect(store.queryOperation({}).total).toBe(0)
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('不可用库的写入计入 failedWrites，查询抛中文错误', () => {
    const broken = createUnavailableLogStore()
    broken.insertRuntime({ at: '2026-09-30T00:00:00.000Z', level: 'info', source: 'a', message: 'x' })
    expect(broken.counters().failedWrites).toBe(1)
    expect(() => broken.queryRuntime({})).toThrow('日志数据库不可用')
  })

  it('storage 不计登录字节，rowCount 为运行与操作行数之和', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'elysian-logs-'))
    const store = openLogStore(join(dir, 'logs.sqlite'))
    store.insertRuntime({ at: '2026-09-30T00:00:00.000Z', level: 'info', source: 'a', message: '运行' })
    store.insertOperation({
      at: '2026-09-30T00:00:01.000Z',
      category: 'files',
      action: '复制',
      target: null,
      summary: 'ok',
      result: 'success',
      method: null,
      path: null,
      httpStatus: null,
    })
    const beforeLogin = store.storage({
      category: 'runtime',
      lastSweepAt: null,
      trimmedBySize: false,
    })
    expect(beforeLogin.rowCount).toBe(2)
    expect(beforeLogin.runtimeRowCount).toBe(1)
    expect(beforeLogin.operationRowCount).toBe(1)
    expect(beforeLogin.runtimeBytes).toBeGreaterThan(0)
    expect(beforeLogin.operationBytes).toBeGreaterThan(0)
    expect(beforeLogin.totalBytes).toBe(beforeLogin.runtimeBytes + beforeLogin.operationBytes)
    expect(beforeLogin.oldestAt).toBe('2026-09-30T00:00:00.000Z')

    store.insertLogin({
      at: '2026-09-29T00:00:00.000Z',
      ip: '127.0.0.1',
      location: '本机',
      userAgent: 't',
      status: 'success',
    })
    const afterLogin = store.storage({
      category: 'login',
      lastSweepAt: '2026-09-30T12:00:00.000Z',
      trimmedBySize: true,
    })
    expect(afterLogin.totalBytes).toBe(beforeLogin.totalBytes)
    expect(afterLogin.runtimeBytes).toBe(beforeLogin.runtimeBytes)
    expect(afterLogin.operationBytes).toBe(beforeLogin.operationBytes)
    expect(afterLogin.rowCount).toBe(2)
    expect(afterLogin.lastSweepAt).toBe('2026-09-30T12:00:00.000Z')
    expect(afterLogin.trimmedBySize).toBe(true)
    store.close()
    await rm(dir, { recursive: true, force: true })
  })
})
