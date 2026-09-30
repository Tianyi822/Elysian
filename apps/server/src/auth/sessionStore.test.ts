import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createFileSessionStore,
  createMemorySessionStore,
  type SessionStore,
} from './sessionStore.ts'
import { SESSION_ABSOLUTE_TTL_MS, SESSION_IDLE_TTL_MS } from './authConfig.ts'

/*
 * 会话存储测试：注入临时目录与可控时钟，锚定 43 字符 base64url 会话 id、滑动续期、
 * 空闲/绝对/epoch 三种失效、惰性清扫、重启持久化与文件权限。
 */

const EPOCH = '2026-09-30T00:00:00.000Z'
const LATER_EPOCH = '2026-10-01T00:00:00.000Z'

let workspace: string | undefined

async function tempDir(): Promise<string> {
  const dir = join(tmpdir(), `elysian-auth-sessions-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  workspace = dir
  return dir
}

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  workspace = undefined
})

describe('createFileSessionStore', () => {
  it('create 产出 43 字符 base64url id 并立即落盘；文件 0600、目录 0700', async () => {
    const dir = await tempDir()
    const path = join(dir, 'state', 'panel-sessions.json')
    const store = createFileSessionStore(path)

    const session = await store.create(EPOCH)
    expect(session.id).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(session.pwdEpoch).toBe(EPOCH)
    expect(session.lastUsedAt).toBe(session.createdAt)

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { version: number; sessions: unknown[] }
    expect(onDisk.version).toBe(1)
    expect(onDisk.sessions).toHaveLength(1)
  })

  it('两次 create 产出不同 id；validate 通过并滑动更新 lastUsedAt', async () => {
    const dir = await tempDir()
    let now = 1_760_000_000_000
    const store = createFileSessionStore(join(dir, 'state', 'panel-sessions.json'), { now: () => now })

    const first = await store.create(EPOCH)
    now += 1000
    const second = await store.create(EPOCH)
    expect(first.id).not.toBe(second.id)

    now += 60_000
    const validated = await store.validate(first.id, EPOCH)
    expect(validated).not.toBeNull()
    expect(validated!.lastUsedAt).toBe(now)
    expect(validated!.createdAt).toBe(first.createdAt)
  })

  it('空闲超过 12 小时：validate 删除该会话并回 null（以最近一次使用为基准滑动）', async () => {
    const dir = await tempDir()
    let now = 1_760_000_000_000
    const store = createFileSessionStore(join(dir, 'state', 'panel-sessions.json'), { now: () => now })
    const session = await store.create(EPOCH)

    now += SESSION_IDLE_TTL_MS - 1
    // 边界内（差 1ms）有效，且 lastUsedAt 滑动到当前时刻。
    await expect(store.validate(session.id, EPOCH)).resolves.not.toBeNull()

    now += SESSION_IDLE_TTL_MS + 1
    // 距最近一次使用已超 12 小时：删除并回 null。
    await expect(store.validate(session.id, EPOCH)).resolves.toBeNull()
    // 删除已落盘：再校验同样回 null。
    await expect(store.validate(session.id, EPOCH)).resolves.toBeNull()
  })

  it('空闲未超时前持续活动可一直续期（滑动窗口）', async () => {
    const dir = await tempDir()
    let now = 1_760_000_000_000
    const store = createFileSessionStore(join(dir, 'state', 'panel-sessions.json'), { now: () => now })
    const session = await store.create(EPOCH)

    for (let i = 1; i <= 20; i += 1) {
      now += SESSION_IDLE_TTL_MS / 2
      await expect(store.validate(session.id, EPOCH)).resolves.not.toBeNull()
    }
  })

  it('绝对上限 7 天：无论活跃，超时即删除回 null', async () => {
    const dir = await tempDir()
    let now = 1_760_000_000_000
    const store = createFileSessionStore(join(dir, 'state', 'panel-sessions.json'), { now: () => now })
    const session = await store.create(EPOCH)

    // 每小时活动一次，直到绝对上限前一天。
    while (now < session.createdAt + SESSION_ABSOLUTE_TTL_MS - 1) {
      now += 60 * 60 * 1000
      await store.validate(session.id, EPOCH)
    }
    now = session.createdAt + SESSION_ABSOLUTE_TTL_MS + 1
    await expect(store.validate(session.id, EPOCH)).resolves.toBeNull()
  })

  it('epoch 不匹配（CLI 已改密）：validate 删除并回 null', async () => {
    const dir = await tempDir()
    const store = createFileSessionStore(join(dir, 'state', 'panel-sessions.json'))
    const session = await store.create(EPOCH)
    await expect(store.validate(session.id, LATER_EPOCH)).resolves.toBeNull()
    await expect(store.validate(session.id, EPOCH)).resolves.toBeNull()
  })

  it('destroy 后 validate 回 null；destroy 不存在的 id 是无害 no-op', async () => {
    const dir = await tempDir()
    const store = createFileSessionStore(join(dir, 'state', 'panel-sessions.json'))
    const session = await store.create(EPOCH)
    await store.destroy(session.id)
    await expect(store.validate(session.id, EPOCH)).resolves.toBeNull()
    await expect(store.destroy('no-such-id')).resolves.toBeUndefined()
  })

  it('list 只回未过期会话且不落盘：调用前后文件内容不变（过期清扫仍由 validate 完成）', async () => {
    const dir = await tempDir()
    const path = join(dir, 'state', 'panel-sessions.json')
    let now = 1_760_000_000_000
    const store = createFileSessionStore(path, { now: () => now })
    const stale = await store.create(EPOCH)
    now += SESSION_IDLE_TTL_MS + 1
    const fresh = await store.create(EPOCH)

    const before = readFileSync(path, 'utf8')
    const listed = await store.list()
    expect(readFileSync(path, 'utf8')).toBe(before)

    // 过期会话被就地过滤：视图里只剩 fresh；磁盘上两者都在（list 不触发清扫）。
    expect(listed.map((session) => session.id)).toEqual([fresh.id])
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { sessions: { id: string }[] }
    expect(onDisk.sessions.map((session) => session.id)).toEqual([stale.id, fresh.id])
  })

  it('destroyOthers 保留 keep 会话、销毁其余并立即落盘；重启后销毁结果可见', async () => {
    const dir = await tempDir()
    const path = join(dir, 'state', 'panel-sessions.json')
    const store = createFileSessionStore(path)
    const first = await store.create(EPOCH)
    const second = await store.create(EPOCH)
    const third = await store.create(EPOCH)

    await store.destroyOthers(second.id)
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { sessions: { id: string }[] }
    expect(onDisk.sessions.map((session) => session.id)).toEqual([second.id])

    const restarted = createFileSessionStore(path)
    await expect(restarted.validate(first.id, EPOCH)).resolves.toBeNull()
    await expect(restarted.validate(second.id, EPOCH)).resolves.not.toBeNull()
    await expect(restarted.validate(third.id, EPOCH)).resolves.toBeNull()
  })

  it('destroyOthers 没有其他会话时不写文件（与 destroy 的无用写规避同纪律），keep 会话仍有效', async () => {
    const dir = await tempDir()
    const path = join(dir, 'state', 'panel-sessions.json')
    const store = createFileSessionStore(path)
    const only = await store.create(EPOCH)

    const before = readFileSync(path, 'utf8')
    await expect(store.destroyOthers(only.id)).resolves.toBeUndefined()
    expect(readFileSync(path, 'utf8')).toBe(before)
    await expect(store.validate(only.id, EPOCH)).resolves.not.toBeNull()
  })

  it('惰性清扫：校验有效会话时顺带剔除磁盘上已过期的其他会话', async () => {
    const dir = await tempDir()
    const path = join(dir, 'state', 'panel-sessions.json')
    let now = 1_760_000_000_000
    const store = createFileSessionStore(path, { now: () => now })
    const stale = await store.create(EPOCH)        // t0 创建，此后不再使用
    now += SESSION_IDLE_TTL_MS + 1                 // stale 的空闲窗口已超
    const active = await store.create(EPOCH)       // 刚创建，必然有效

    await expect(store.validate(active.id, EPOCH)).resolves.not.toBeNull()
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { sessions: { id: string }[] }
    expect(onDisk.sessions.map((session) => session.id)).toEqual([active.id])
    await expect(store.validate(stale.id, EPOCH)).resolves.toBeNull()
  })

  it('重启（新 store 实例同路径）会话仍有效', async () => {
    const dir = await tempDir()
    const path = join(dir, 'state', 'panel-sessions.json')
    const first = createFileSessionStore(path)
    const session = await first.create(EPOCH)

    const second = createFileSessionStore(path)
    await expect(second.validate(session.id, EPOCH)).resolves.not.toBeNull()
  })

  it('会话文件损坏（坏 JSON）时按空表处理：重启后的 validate 回 null、create 可重建', async () => {
    const dir = await tempDir()
    const path = join(dir, 'state', 'panel-sessions.json')
    const store = createFileSessionStore(path)
    const session = await store.create(EPOCH)
    expect(JSON.parse(readFileSync(path, 'utf8')).sessions).toHaveLength(1)

    // 会话文件只有面板进程一个写者（CLI 不碰它）；损坏只能发生在进程之外，
    // 因此按「重启后首次加载」的语义断言：新实例读到坏文件 → 空表 → fail closed。
    writeFileSync(path, '{corrupt', { mode: 0o600 })
    const restarted = createFileSessionStore(path)
    await expect(restarted.validate(session.id, EPOCH)).resolves.toBeNull()

    const rebuilt = await restarted.create(EPOCH)
    await expect(restarted.validate(rebuilt.id, EPOCH)).resolves.not.toBeNull()
  })
})

describe('createMemorySessionStore', () => {
  it('与文件版同语义：创建、滑动、空闲超时、epoch 失效、销毁', async () => {
    let now = 1_760_000_000_000
    const store: SessionStore = createMemorySessionStore({ now: () => now })
    const session = await store.create(EPOCH)
    expect(session.id).toMatch(/^[A-Za-z0-9_-]{43}$/)

    now += 60_000
    await expect(store.validate(session.id, EPOCH)).resolves.not.toBeNull()

    now += SESSION_IDLE_TTL_MS + 1
    const second = await store.create(EPOCH)
    await expect(store.validate(session.id, EPOCH)).resolves.toBeNull()
    await expect(store.validate(second.id, EPOCH)).resolves.not.toBeNull()

    await store.destroy(second.id)
    await expect(store.validate(second.id, EPOCH)).resolves.toBeNull()
  })

  it('与文件版同语义：list 只回未过期会话，destroyOthers 保留 keep 会话、销毁其余', async () => {
    let now = 1_760_000_000_000
    const store: SessionStore = createMemorySessionStore({ now: () => now })
    const first = await store.create(EPOCH)
    now += 60_000
    const second = await store.create(EPOCH)

    // 全部未过期：视图两行齐全。
    expect((await store.list()).map((session) => session.id)).toEqual([first.id, second.id])

    // first 距上次使用已超 12h，second 还差半分钟未超时。
    now += SESSION_IDLE_TTL_MS - 30_000
    const third = await store.create(EPOCH)
    expect((await store.list()).map((session) => session.id)).toEqual([second.id, third.id])

    await store.destroyOthers(third.id)
    expect((await store.list()).map((session) => session.id)).toEqual([third.id])
    await expect(store.validate(second.id, EPOCH)).resolves.toBeNull()
    await expect(store.validate(third.id, EPOCH)).resolves.not.toBeNull()
  })
})
