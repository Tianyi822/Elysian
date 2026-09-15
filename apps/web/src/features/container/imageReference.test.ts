import { describe, expect, it } from 'vitest'
import { parseImageReference } from './imageReference'

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
