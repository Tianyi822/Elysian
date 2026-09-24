import { describe, expect, it, vi } from 'vitest'
import { isPublicAddress, validateRegistry } from './registryPolicy.ts'

const PUBLIC_RESOLVE: (hostname: string) => Promise<readonly string[]> = async () => ['1.2.3.4']

describe('validateRegistry', () => {
  it('https 镜像源去掉协议后返回主机名', async () => {
    await expect(validateRegistry('https://docker.m.daocloud.io', PUBLIC_RESOLVE)).resolves.toBe(
      'docker.m.daocloud.io',
    )
  })

  it('拒绝 http 协议', async () => {
    await expect(validateRegistry('http://example.com', PUBLIC_RESOLVE)).rejects.toThrow()
  })

  it('拒绝字面 IP、本机名、内网后缀与 Docker 内置 registry 主机名', async () => {
    const resolve = vi.fn(PUBLIC_RESOLVE)
    for (const raw of ['10.0.0.1', 'localhost', 'registry', 'foo.local']) {
      await expect(validateRegistry(raw, resolve)).rejects.toThrow()
    }
    expect(resolve).not.toHaveBeenCalled()
  })

  it('解析到非公网地址时拒绝', async () => {
    const cases = ['10.1.2.3', '127.0.0.1', '100.64.0.1', '::ffff:192.168.0.1', 'fd00::1']
    for (const ip of cases) {
      await expect(
        validateRegistry('mirror.example.com', async () => [ip]),
      ).rejects.toThrow('镜像源无法解析为公网地址')
    }
  })

  it('解析失败或超时与非公网地址同样报错', async () => {
    await expect(
      validateRegistry('mirror.example.com', async () => {
        throw new Error('ENOTFOUND')
      }),
    ).rejects.toThrow('镜像源无法解析为公网地址')

    await expect(
      validateRegistry('mirror.example.com', () => Promise.reject(new Error('timeout'))),
    ).rejects.toThrow('镜像源无法解析为公网地址')
  })

  it('带端口的公网域名解析成功', async () => {
    await expect(validateRegistry('example.com:5000', async () => ['1.2.3.4'])).resolves.toBe(
      'example.com:5000',
    )
  })
})

describe('isPublicAddress', () => {
  it('公网 IPv4 为真', () => {
    expect(isPublicAddress('1.2.3.4')).toBe(true)
  })

  it('内网、回环与 CGNAT 为假', () => {
    expect(isPublicAddress('10.1.2.3')).toBe(false)
    expect(isPublicAddress('127.0.0.1')).toBe(false)
    expect(isPublicAddress('100.64.0.1')).toBe(false)
    expect(isPublicAddress('::ffff:192.168.0.1')).toBe(false)
    expect(isPublicAddress('fd00::1')).toBe(false)
  })
})
