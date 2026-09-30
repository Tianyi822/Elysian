import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createFileCredentialsStore,
  createMemoryCredentialsStore,
  ensureFirstBootCredentials,
  type PanelCredentials,
} from './credentialsStore.ts'
import { createScryptHasher } from './passwordHasher.ts'
import { AUTH_DEV_WARNING } from './authConfig.ts'

/*
 * 凭据文件测试：注入临时目录，锚定 JSON 形状、0600 权限、直读不缓存（CLI 改密被
 * server 下一次 current() 感知的行为锚点）与 fail closed。首启保障（ensureFirstBoot
 * Credentials）用注入的打印函数断言横幅与跳过语义，不真打 stdout。
 */

let workspace: string | undefined

async function tempDir(): Promise<string> {
  const dir = join(tmpdir(), `elysian-auth-credentials-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  workspace = dir
  return dir
}

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  workspace = undefined
})

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { mode: 0o600 })
}

describe('createFileCredentialsStore', () => {
  it('文件缺失时 current() 回 null', async () => {
    const dir = await tempDir()
    const store = createFileCredentialsStore(join(dir, 'config', 'panel-credentials.json'))
    await expect(store.current()).resolves.toBeNull()
  })

  it('write 落盘 JSON 形状：version 1、admin、scrypt 串与新的 passwordChangedAt；current 读回一致', async () => {
    const dir = await tempDir()
    const path = join(dir, 'config', 'panel-credentials.json')
    const store = createFileCredentialsStore(path)
    const written = await store.write('scrypt:16384:8:1:AAAA:BBBB')

    expect(written.username).toBe('admin')
    expect(written.passwordHash).toBe('scrypt:16384:8:1:AAAA:BBBB')
    expect(written.passwordChangedAt).toBe(new Date(written.passwordChangedAt).toISOString())

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as unknown
    expect(onDisk).toEqual({ version: 1, ...written })
    await expect(store.current()).resolves.toEqual(written)
  })

  it('write 的文件权限是 0600、目录是 0700', async () => {
    const dir = await tempDir()
    const path = join(dir, 'config', 'panel-credentials.json')
    const store = createFileCredentialsStore(path)
    await store.write('scrypt:16384:8:1:AAAA:BBBB')

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'config')).mode & 0o777).toBe(0o700)
  })

  it('第二次 write 换哈希并推进 passwordChangedAt（会话 epoch 的失效基准）', async () => {
    const dir = await tempDir()
    const store = createFileCredentialsStore(join(dir, 'config', 'panel-credentials.json'))
    const first = await store.write('scrypt:16384:8:1:AAAA:BBBB')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await store.write('scrypt:16384:8:1:CCCC:DDDD')
    expect(second.passwordHash).toBe('scrypt:16384:8:1:CCCC:DDDD')
    expect(new Date(second.passwordChangedAt).getTime()).toBeGreaterThan(new Date(first.passwordChangedAt).getTime())
  })

  it('无缓存直读：同一 store 实例下外部改写文件，下一次 current() 立即反映新内容', async () => {
    const dir = await tempDir()
    const path = join(dir, 'config', 'panel-credentials.json')
    const store = createFileCredentialsStore(path)
    const mine = await store.write('scrypt:16384:8:1:AAAA:BBBB')

    // CLI 改密等价于另一个进程写同一文件（passwordChangedAt 推进、哈希更换）。
    const external: PanelCredentials = { ...mine, passwordHash: 'scrypt:16384:8:1:EEEE:FFFF', passwordChangedAt: '2026-10-01T00:00:00.000Z' }
    writePrivate(path, JSON.stringify({ version: 1, ...external }))

    await expect(store.current()).resolves.toEqual(external)
  })

  it('坏文件 fail closed：坏 JSON、缺字段、版本不符、权限放宽一律回 null', async () => {
    const dir = await tempDir()
    const path = join(dir, 'config', 'panel-credentials.json')
    const store = createFileCredentialsStore(path)

    writePrivate(path, '{not-json')
    await expect(store.current()).resolves.toBeNull()

    writePrivate(path, JSON.stringify({ version: 1, username: 'admin' }))
    await expect(store.current()).resolves.toBeNull()

    writePrivate(path, JSON.stringify({ version: 2, username: 'admin', passwordHash: 'x', passwordChangedAt: '2026-09-30T00:00:00.000Z' }))
    await expect(store.current()).resolves.toBeNull()

    // 权限被放宽（0644）也视为不可用：凭据文件不该是全局可读的。
    writePrivate(path, JSON.stringify({ version: 1, username: 'admin', passwordHash: 'x', passwordChangedAt: '2026-09-30T00:00:00.000Z' }))
    chmodSync(path, 0o644)
    await expect(store.current()).resolves.toBeNull()
  })
})

describe('createMemoryCredentialsStore', () => {
  it('缺省为空；write 后 current 一致', async () => {
    const store = createMemoryCredentialsStore()
    await expect(store.current()).resolves.toBeNull()
    const written = await store.write('scrypt:16384:8:1:AAAA:BBBB')
    await expect(store.current()).resolves.toEqual(written)
  })

  it('以初始凭据构造时 current 回深拷贝（外部改动不影响内部）', async () => {
    const initial: PanelCredentials = { username: 'admin', passwordHash: 'h', passwordChangedAt: '2026-09-30T00:00:00.000Z' }
    const store = createMemoryCredentialsStore(initial)
    initial.passwordHash = 'mutated'
    const current = await store.current()
    expect(current?.passwordHash).toBe('h')
  })
})

describe('ensureFirstBootCredentials', () => {
  const hasher = createScryptHasher()

  it('dev 开时只打警告行、不生成文件', async () => {
    const dir = await tempDir()
    const store = createFileCredentialsStore(join(dir, 'config', 'panel-credentials.json'))
    const printed: string[] = []
    const outcome = await ensureFirstBootCredentials(store, { dev: true, hasher, print: (line) => printed.push(line) })
    expect(outcome).toBe('dev-skipped')
    await expect(store.current()).resolves.toBeNull()
    expect(printed).toEqual([AUTH_DEV_WARNING])
  })

  it('凭据文件已存在时直接返回，不打印任何内容', async () => {
    const dir = await tempDir()
    const store = createFileCredentialsStore(join(dir, 'config', 'panel-credentials.json'))
    const created = await store.write(await hasher.hash('existing'))
    const printed: string[] = []
    const outcome = await ensureFirstBootCredentials(store, { dev: false, hasher, print: (line) => printed.push(line) })
    expect(outcome).toBe('already-present')
    expect(printed).toEqual([])
    await expect(store.current()).resolves.toEqual(created)
  })

  it('首启生成随机密码：横幅含用户名与 16 字符密码、密码可登录、文件已落盘', async () => {
    const dir = await tempDir()
    const store = createFileCredentialsStore(join(dir, 'config', 'panel-credentials.json'))
    const printed: string[] = []
    const outcome = await ensureFirstBootCredentials(store, { dev: false, hasher, print: (line) => printed.push(line) })

    expect(outcome).toBe('created')
    const banner = printed.join('\n')
    expect(banner).toContain('用户名：admin')
    expect(banner).toContain('初始密码：')
    const password = banner.slice(banner.indexOf('初始密码：') + '初始密码：'.length).split('\n')[0] ?? ''
    expect(password).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{16}$/)

    const stored = await store.current()
    expect(stored).not.toBeNull()
    await expect(hasher.verify(password, stored!.passwordHash)).resolves.toBe(true)
  })

  it('两次首启生成不同密码（随机）', async () => {
    const passwords: string[] = []
    for (let i = 0; i < 2; i += 1) {
      const dir = await tempDir()
      const store = createFileCredentialsStore(join(dir, 'config', 'panel-credentials.json'))
      const printed: string[] = []
      await ensureFirstBootCredentials(store, { dev: false, hasher, print: (line) => printed.push(line) })
      const banner = printed.join('\n')
      passwords.push(banner.slice(banner.indexOf('初始密码：') + '初始密码：'.length).split('\n')[0] ?? '')
    }
    expect(passwords[0]).not.toBe(passwords[1])
  })
})
