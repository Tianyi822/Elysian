import { describe, expect, it } from 'vitest'
import { autoContainerName, parseShellWords } from '../index.ts'

describe('parseShellWords', () => {
  it('redis-server --appendonly yes 分为三个参数', () => {
    const result = parseShellWords('redis-server --appendonly yes')
    expect(result).toEqual({ ok: true, args: ['redis-server', '--appendonly', 'yes'] })
  })

  it('双引号与单引号各保留内部空格为一个参数', () => {
    expect(parseShellWords('"hello world"')).toEqual({ ok: true, args: ['hello world'] })
    expect(parseShellWords("'hello world'")).toEqual({ ok: true, args: ['hello world'] })
  })

  it('未闭合引号失败，消息含「引号」', () => {
    const single = parseShellWords("'open")
    expect(single.ok).toBe(false)
    if (!single.ok) expect(single.error).toContain('引号')

    const double = parseShellWords('"open')
    expect(double.ok).toBe(false)
    if (!double.ok) expect(double.error).toContain('引号')
  })

  it('含换行失败', () => {
    const result = parseShellWords('a\nb')
    expect(result.ok).toBe(false)
  })

  it('超过 256 个参数失败', () => {
    const words = Array.from({ length: 257 }, (_, i) => `w${i}`).join(' ')
    const result = parseShellWords(words)
    expect(result.ok).toBe(false)
  })

  it('空白输入得到空参数列表', () => {
    expect(parseShellWords('')).toEqual({ ok: true, args: [] })
    expect(parseShellWords('   \t  ')).toEqual({ ok: true, args: [] })
  })

  it('反斜杠只转义下一个字符，不展开 $', () => {
    expect(parseShellWords('echo $HOME')).toEqual({ ok: true, args: ['echo', '$HOME'] })
    expect(parseShellWords('a\\ b')).toEqual({ ok: true, args: ['a b'] })
    expect(parseShellWords('\\\\')).toEqual({ ok: true, args: ['\\'] })
  })
})

describe('autoContainerName', () => {
  it('grafana/grafana → grafana-grafana', () => {
    expect(autoContainerName([], 'grafana/grafana')).toBe('grafana-grafana')
  })

  it('名称冲突时从 -2 起递增', () => {
    expect(autoContainerName([{ name: 'redis' }], 'redis')).toBe('redis-2')
    expect(
      autoContainerName([{ name: 'redis' }, { name: 'redis-2' }], 'redis'),
    ).toBe('redis-3')
  })
})
