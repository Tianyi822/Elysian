import { describe, expect, it } from 'vitest'
import {
  filesPathSegments,
  joinFilesPath,
  normalizeFilesPath,
  parentFilesPath,
  pickPathDropCount,
} from './filesPath'

describe('URL 通配段归一为绝对路径', () => {
  it.each([
    ['', '/'],
    ['var', '/var'],
    ['var/log', '/var/log'],
    ['var/log/', '/var/log'],
    ['/var/log', '/var/log'],
    ['//var//log//', '/var/log'],
  ])('%j 归一为 %j', (raw, expected) => {
    expect(normalizeFilesPath(raw)).toBe(expected)
  })
})

describe('目录路径拼接', () => {
  it('根目录拼出不带双斜杠', () => {
    expect(joinFilesPath('/', 'var')).toBe('/var')
  })

  it('子目录往后追加一段', () => {
    expect(joinFilesPath('/var', 'log')).toBe('/var/log')
  })
})

describe('父目录', () => {
  it.each([
    ['/', '/'],
    ['/var', '/'],
    ['/var/log', '/var'],
    ['/var/lib/docker/containers', '/var/lib/docker'],
  ])('%j 的父目录是 %j', (path, expected) => {
    expect(parentFilesPath(path)).toBe(expected)
  })
})

describe('路径切段', () => {
  it('根目录切出空数组', () => {
    expect(filesPathSegments('/')).toEqual([])
  })

  it('按斜杠切段，不带首尾空段', () => {
    expect(filesPathSegments('/var/lib/docker')).toEqual(['var', 'lib', 'docker'])
  })
})

describe('顶栏路径的前段省略', () => {
  // 每段的渲染宽度（含前导斜杠）：/var=36、/lib=24、/docker=48；省略号 12。
  const WIDTHS = [36, 24, 48]
  const ELLIPSIS = 12

  it('放得下就一段不丢', () => {
    expect(pickPathDropCount(WIDTHS, ELLIPSIS, 108)).toBe(0)
  })

  it('刚好放得下也算放下', () => {
    expect(pickPathDropCount(WIDTHS, ELLIPSIS, 36 + 24 + 48)).toBe(0)
  })

  it('整条放不下时先丢最前面一段', () => {
    // 丢一段后 12 + 24 + 48 = 84，90 的预算放得下；整条 108 放不下。
    expect(pickPathDropCount(WIDTHS, ELLIPSIS, 90)).toBe(1)
    expect(pickPathDropCount(WIDTHS, ELLIPSIS, 84)).toBe(1)
  })

  it('越来越窄逐段往后丢', () => {
    // 丢一段 84 放不下、丢两段 12 + 48 = 60 恰好放下。
    expect(pickPathDropCount(WIDTHS, ELLIPSIS, 60)).toBe(2)
    expect(pickPathDropCount(WIDTHS, ELLIPSIS, 83)).toBe(2)
  })

  it('再窄也保留最后一段，不丢光', () => {
    expect(pickPathDropCount(WIDTHS, ELLIPSIS, 0)).toBe(2)
    expect(pickPathDropCount(WIDTHS, ELLIPSIS, -20)).toBe(2)
  })

  it('可用宽度未知（Infinity，测试环境）时不丢段', () => {
    expect(pickPathDropCount(WIDTHS, ELLIPSIS, Number.POSITIVE_INFINITY)).toBe(0)
  })
})
