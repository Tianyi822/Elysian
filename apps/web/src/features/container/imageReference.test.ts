import { describe, expect, it } from 'vitest'
import { invalidImageRegistries, officialImageRegistries } from '../../test/imageRegistryCases'
import {
  DEFAULT_IMAGE_REGISTRY,
  parseImageReference,
  registryHost,
  validateRegistryUrl,
} from './imageReference'

describe('镜像引用解析', () => {
  it('拆分名称与标签；缺标签默认 latest，名称统一转小写', () => {
    expect(parseImageReference('redis:8-alpine')).toEqual({
      ok: true,
      reference: { name: 'redis', tag: '8-alpine' },
    })
    expect(parseImageReference('  nginx  ')).toEqual({
      ok: true,
      reference: { name: 'nginx', tag: 'latest' },
    })
    expect(parseImageReference('Grafana/Grafana:v11')).toEqual({
      ok: true,
      reference: { name: 'grafana/grafana', tag: 'v11' },
    })
  })

  it('按最后一个冒号拆分：registry 带端口的引用正确解析', () => {
    expect(parseImageReference('registry.local:5000/ops/agent')).toEqual({
      ok: true,
      reference: { name: 'registry.local:5000/ops/agent', tag: 'latest' },
    })
    expect(parseImageReference('registry.local:5000/ops/agent:v2')).toEqual({
      ok: true,
      reference: { name: 'registry.local:5000/ops/agent', tag: 'v2' },
    })
  })

  it('空输入、非法名称、非法标签给出中文原因', () => {
    expect(parseImageReference('')).toMatchObject({ ok: false })
    expect(parseImageReference('   ')).toMatchObject({ ok: false })
    expect(parseImageReference(':latest')).toMatchObject({ ok: false })
    expect(parseImageReference('缓存:latest') satisfies ReturnType<typeof parseImageReference>).toMatchObject({
      ok: false,
    })
    expect(parseImageReference('-nginx')).toMatchObject({ ok: false })
    expect(parseImageReference('redis:坏标签')).toMatchObject({ ok: false })
  })
})

describe('拉取源', () => {
  it('默认官方地址是 Docker Hub', () => {
    expect(DEFAULT_IMAGE_REGISTRY).toBe('https://registry-1.docker.io')
  })

  it('自定义地址校验：留空合法（回落官方），非空须主机名或 URL', () => {
    expect(validateRegistryUrl('')).toBeUndefined()
    expect(validateRegistryUrl('docker.m.daocloud.io')).toBeUndefined()
    expect(validateRegistryUrl('https://mirror.local:5000')).toBeUndefined()
    expect(validateRegistryUrl('https://mirror.local:5000/')).toBeUndefined()
    expect(validateRegistryUrl('镜像.本地')).toContain('主机名')
  })

  it.each(officialImageRegistries)('官方地址 %j 可以通过前端校验', (registry) => {
    expect(validateRegistryUrl(registry)).toBeUndefined()
  })

  it.each(invalidImageRegistries)('非法地址 %j 继续被前端拦截', (registry) => {
    expect(validateRegistryUrl(registry)).toContain('主机名')
  })

  it('只有斜杠不作为留空，仍然报错', () => {
    expect(validateRegistryUrl('///')).toContain('主机名')
  })

  it('主机名显示剥掉协议前缀与尾斜杠', () => {
    expect(registryHost('https://docker.1ms.run')).toBe('docker.1ms.run')
    expect(registryHost('mirror.local')).toBe('mirror.local')
    expect(registryHost(' https://registry-1.docker.io:443/// ')).toBe('registry-1.docker.io:443')
    expect(registryHost('docker.io/')).toBe('docker.io')
  })
})
