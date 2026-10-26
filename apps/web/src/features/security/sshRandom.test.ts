import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomSshPort, randomStrongPassword } from './sshRandom'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('SSH 候选值生成', () => {
  it('随机端口落在 1024-65535', () => {
    const port = randomSshPort()
    expect(port).toBeGreaterThanOrEqual(1024)
    expect(port).toBeLessThanOrEqual(65535)
  })

  it('强密码覆盖四类字符且不使用 Math.random', () => {
    const predictable = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('不应使用 Math.random') })
    const password = randomStrongPassword(20)
    expect(password).toHaveLength(20)
    expect(password).toMatch(/[a-z]/)
    expect(password).toMatch(/[A-Z]/)
    expect(password).toMatch(/[0-9]/)
    expect(password).toMatch(/[!@#$%^&*_=+-]/)
    expect(predictable).not.toHaveBeenCalled()
  })

  it('WebCrypto 缺失时明确失败，不回退可预测随机源', () => {
    vi.stubGlobal('crypto', undefined)
    expect(() => randomStrongPassword()).toThrow('无法生成安全随机数')
    expect(() => randomSshPort()).toThrow('无法生成安全随机数')
  })
})
