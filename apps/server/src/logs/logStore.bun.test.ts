import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOG_ENTRY_FETCH_LIMIT } from '@elysian/contracts'
import { LOG_RECORD_MAX_BYTES } from './logRecords'
import { openLogStore } from './logStore'

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
})
