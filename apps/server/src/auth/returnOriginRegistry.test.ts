import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createFileReturnOriginRegistry,
  createMemoryReturnOriginRegistry,
} from './returnOriginRegistry.ts'
import { RETURN_ORIGINS_MAX_BYTES, SSO_ORIGIN_IGNORED, SSO_ORIGINS_UNAVAILABLE } from './authConfig.ts'

/*
 * 白名单文件测试：注入临时目录。锚定「不可用退化为空表、单项坏只丢该项、直读不缓存」，
 * 以及诊断文案经 console.error 落 stderr。缺文件与坏内容都不得让面板登录或探测受影响。
 */

let workspace: string | undefined

async function tempDir(): Promise<string> {
  const dir = join(tmpdir(), `elysian-sso-origins-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  workspace = dir
  return dir
}

function writeOrigins(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  workspace = undefined
  vi.restoreAllMocks()
})

describe('createFileReturnOriginRegistry', () => {
  it('合法文件读回原样 origin 列表', async () => {
    const dir = await tempDir()
    const path = join(dir, 'config', 'sso-return-origins.json')
    writeOrigins(path, JSON.stringify({ version: 1, origins: ['http://127.0.0.1:5173', 'http://127.0.0.1:48100'] }))
    await expect(createFileReturnOriginRegistry(path).list()).resolves.toEqual(['http://127.0.0.1:5173', 'http://127.0.0.1:48100'])
  })

  it('文件缺失：空表加一行中文诊断，不抛错', async () => {
    const dir = await tempDir()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const registry = createFileReturnOriginRegistry(join(dir, 'config', 'sso-return-origins.json'))
    await expect(registry.list()).resolves.toEqual([])
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0]![0]).toContain(SSO_ORIGINS_UNAVAILABLE)
  })

  it('坏 JSON、顶层非对象、缺 origins、非数组、version 不为 1：都退化为空表并各打一行诊断', async () => {
    const dir = await tempDir()
    const cases = [
      'not json',
      JSON.stringify(['http://127.0.0.1:5173']),
      JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 1, origins: 'http://127.0.0.1:5173' }),
      JSON.stringify({ version: 2, origins: ['http://127.0.0.1:5173'] }),
    ]
    for (const [index, content] of cases.entries()) {
      const path = join(dir, `bad-${index}.json`)
      writeOrigins(path, content)
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      await expect(createFileReturnOriginRegistry(path).list()).resolves.toEqual([])
      expect(errors).toHaveBeenCalledTimes(1)
      expect(errors.mock.calls[0]![0]).toContain(SSO_ORIGINS_UNAVAILABLE)
      errors.mockRestore()
    }
  })

  it('单项不合法只丢该项：尾斜杠、带 path、非回环 host、非字符串都丢弃并逐行提示', async () => {
    const dir = await tempDir()
    const path = join(dir, 'mixed.json')
    writeOrigins(
      path,
      JSON.stringify({
        version: 1,
        origins: ['http://127.0.0.1:5173/', 'http://127.0.0.1:5173/app', 'http://evil.example', 42, 'http://127.0.0.1:5173', 'http://localhost:3000'],
      }),
    )
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(createFileReturnOriginRegistry(path).list()).resolves.toEqual(['http://127.0.0.1:5173', 'http://localhost:3000'])
    const ignored = errors.mock.calls.filter((call) => String(call[0]).startsWith(SSO_ORIGIN_IGNORED))
    expect(ignored).toHaveLength(4)
    expect(ignored[3]![0]).toContain('42')
  })

  it('IPv6 回环字面量合法', async () => {
    const dir = await tempDir()
    const path = join(dir, 'v6.json')
    writeOrigins(path, JSON.stringify({ version: 1, origins: ['http://[::1]:5173'] }))
    await expect(createFileReturnOriginRegistry(path).list()).resolves.toEqual(['http://[::1]:5173'])
  })

  it('超过体积上限视为不可用：空表加诊断', async () => {
    const dir = await tempDir()
    const path = join(dir, 'huge.json')
    const padding = 'x'.repeat(RETURN_ORIGINS_MAX_BYTES)
    writeOrigins(path, JSON.stringify({ version: 1, origins: ['http://127.0.0.1:5173'], padding }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(createFileReturnOriginRegistry(path).list()).resolves.toEqual([])
    expect(errors.mock.calls[0]![0]).toContain(SSO_ORIGINS_UNAVAILABLE)
  })

  it('每次直读不缓存：外部改写后下一次 list() 立即反映', async () => {
    const dir = await tempDir()
    const path = join(dir, 'live.json')
    writeOrigins(path, JSON.stringify({ version: 1, origins: ['http://127.0.0.1:5173'] }))
    const registry = createFileReturnOriginRegistry(path)
    await expect(registry.list()).resolves.toEqual(['http://127.0.0.1:5173'])
    writeOrigins(path, JSON.stringify({ version: 1, origins: ['http://127.0.0.1:8080'] }))
    await expect(registry.list()).resolves.toEqual(['http://127.0.0.1:8080'])
  })

  it('最终组件是符号链接时按不可用处理（O_NOFOLLOW）', async () => {
    const { symlink } = await import('node:fs/promises')
    const dir = await tempDir()
    const target = join(dir, 'target.json')
    const link = join(dir, 'link.json')
    writeOrigins(target, JSON.stringify({ version: 1, origins: ['http://127.0.0.1:5173'] }))
    await symlink(target, link)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(createFileReturnOriginRegistry(link).list()).resolves.toEqual([])
    expect(errors.mock.calls[0]![0]).toContain(SSO_ORIGINS_UNAVAILABLE)
  })
})

describe('createMemoryReturnOriginRegistry', () => {
  it('缺省空表；注入值原样读回', async () => {
    await expect(createMemoryReturnOriginRegistry().list()).resolves.toEqual([])
    await expect(createMemoryReturnOriginRegistry(['http://127.0.0.1:5173']).list()).resolves.toEqual(['http://127.0.0.1:5173'])
  })
})
