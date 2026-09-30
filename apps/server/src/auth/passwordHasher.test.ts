import { describe, expect, it } from 'vitest'
import { createScryptHasher } from './passwordHasher.ts'
import { DUMMY_HASH } from './authConfig.ts'

/*
 * 密码哈希契约测试：scrypt 往返、格式串解析与恒定时间比较。node:crypto 在 Bun 与
 * Node 上行为一致，本文件在 vitest 的 node 模块图里直接可测（不使用 Bun.password
 * 的全部理由，见设计文档「密码哈希」节）。
 */

describe('createScryptHasher', () => {
  it('hash/verify 往返：正确密码 true', async () => {
    const hasher = createScryptHasher()
    const stored = await hasher.hash('correct horse battery staple')
    expect(stored).toMatch(/^scrypt:16384:8:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
    await expect(hasher.verify('correct horse battery staple', stored)).resolves.toBe(true)
  })

  it('错误密码 false', async () => {
    const hasher = createScryptHasher()
    const stored = await hasher.hash('right-password')
    await expect(hasher.verify('wrong-password', stored)).resolves.toBe(false)
  })

  it('stored 格式非法一律回 false，绝不抛错', async () => {
    const hasher = createScryptHasher()
    const invalid = [
      '',
      'plain-text',
      'scrypt:16384:8:1',                       // 缺段
      'scrypt:16384:8:1:only-one-segment',      // 缺哈希段
      'bcrypt:16384:8:1:aaaa:bbbb',             // 前缀不是 scrypt
      `scrypt:abc:8:1:${Buffer.alloc(16).toString('base64')}:${Buffer.alloc(32).toString('base64')}`, // 参数非数字
      'scrypt:16384:8:1:!!!not-base64!!!:####', // 坏 base64
    ]
    for (const stored of invalid) {
      await expect(hasher.verify('whatever', stored)).resolves.toBe(false)
    }
  })

  it('盐随机：同明文两次哈希产出不同串，且互相验证不了对方的盐', async () => {
    const hasher = createScryptHasher()
    const first = await hasher.hash('same-plain')
    const second = await hasher.hash('same-plain')
    expect(first).not.toBe(second)
    expect(first.split(':')[4]).not.toBe(second.split(':')[4])
    await expect(hasher.verify('same-plain', first)).resolves.toBe(true)
    await expect(hasher.verify('same-plain', second)).resolves.toBe(true)
  })

  it('哑哈希常量是格式合法的 scrypt 串：verify 可正常跑完并回 false（时序对齐的前提）', async () => {
    const hasher = createScryptHasher()
    await expect(hasher.verify('any-input', DUMMY_HASH)).resolves.toBe(false)
  })
})
