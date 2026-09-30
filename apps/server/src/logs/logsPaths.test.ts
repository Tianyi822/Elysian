import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLATFORM_LOGS_DIR,
  compareLogShards,
  logCategoryDir,
  logShardName,
  parseLogShardName,
  utcDayKey,
  utcDayKeyOfShard,
} from './logsPaths'

/*
 * 纯文件名的行为测试：构造/解析往返（含 `_2` 后缀）、非本模块形态返回 null、
 * 「字典序 = 时间序」（含冲突后缀不破坏它）、UTC 日键。全部纯计算，不碰文件系统，
 * 不读真实 home——目录断言用注入的根。
 */

const AT = new Date('2026-09-23T03:15:00.000Z')

describe('logCategoryDir', () => {
  it('类别目录落在平台日志根下；默认根经 elysianPaths 出口', () => {
    expect(logCategoryDir('runtime')).toBe(`${DEFAULT_PLATFORM_LOGS_DIR}/runtime`)
    expect(logCategoryDir('operation')).toBe(`${DEFAULT_PLATFORM_LOGS_DIR}/operation`)
    expect(DEFAULT_PLATFORM_LOGS_DIR).toMatch(/logs\/platform$/)
  })

  it('注入根目录时使用注入值（测试与其它部署形态）', () => {
    expect(logCategoryDir('runtime', '/tmp/x/platform')).toBe('/tmp/x/platform/runtime')
  })
})

describe('logShardName 与 parseLogShardName', () => {
  it('构造固定宽度基本格式，解析往返得到秒精度时刻', () => {
    expect(logShardName('runtime', AT, false)).toBe('runtime-20260923T031500Z.jsonl')
    expect(logShardName('operation', AT, true)).toBe('operation-20260923T031500Z.jsonl.gz')
    expect(logShardName('login', AT, false)).toBe('login-20260923T031500Z.jsonl')
    expect(parseLogShardName('login-20260923T031500Z.jsonl')).toEqual({
      category: 'login',
      at: '2026-09-23T03:15:00Z',
      compressed: false,
    })
    expect(parseLogShardName('runtime-20260923T031500Z.jsonl')).toEqual({
      category: 'runtime',
      at: '2026-09-23T03:15:00Z',
      compressed: false,
    })
    expect(parseLogShardName('operation-20260923T031500Z.jsonl.gz')).toEqual({
      category: 'operation',
      at: '2026-09-23T03:15:00Z',
      compressed: true,
    })
  })

  it('毫秒不入名：同秒内的两个时刻产生同一个基名', () => {
    expect(logShardName('runtime', new Date('2026-09-23T03:15:00.001Z'), false)).toBe(
      logShardName('runtime', AT, false),
    )
    expect(logShardName('runtime', new Date('2026-09-23T03:15:00.999Z'), false)).toBe(
      logShardName('runtime', AT, false),
    )
  })

  it('冲突后缀 `_2`、`_3` 的构造与解析往返', () => {
    expect(logShardName('runtime', AT, false, 2)).toBe('runtime-20260923T031500Z_2.jsonl')
    expect(logShardName('runtime', AT, true, 3)).toBe('runtime-20260923T031500Z_3.jsonl.gz')
    expect(parseLogShardName('runtime-20260923T031500Z_2.jsonl')).toEqual({
      category: 'runtime',
      at: '2026-09-23T03:15:00Z',
      compressed: false,
    })
    // duplicateIndex 省略与为 1 都产出基本形态。
    expect(logShardName('runtime', AT, false, 1)).toBe(logShardName('runtime', AT, false))
  })

  it('字典序 = 时间序，冲突后缀排在基名之后（`-2` 会排到基名之前，故不用它）', () => {
    const names = [
      logShardName('runtime', new Date('2026-09-23T03:15:01Z'), false),
      logShardName('runtime', AT, false, 2),
      logShardName('runtime', AT, false),
    ]
    expect([...names].sort()).toEqual([
      'runtime-20260923T031500Z.jsonl',
      'runtime-20260923T031500Z_2.jsonl',
      'runtime-20260923T031501Z.jsonl',
    ])
  })

  it('非本模块形态一律返回 null', () => {
    for (const name of [
      'sshd.log',
      'runtime-20260923T031500Z.jsonl.gz.tmp',
      'runtime-20260923T031500Z_1.jsonl',
      'runtime-20260923T031500Z-2.jsonl',
      'runtime-20260923T031500.jsonl',
      'host-20260923T031500Z.jsonl',
      'runtime-20260923T031500Z.txt',
      'runtime-20261301T031500Z.jsonl',
      'runtime-20260230T031500Z.jsonl',
      'runtime-20260923T031500Z.jsonl.gz.gz',
      'platform',
      '',
    ]) {
      expect(parseLogShardName(name)).toBeNull()
    }
  })
})

describe('UTC 日键', () => {
  it('utcDayKey 取 UTC 自然日；跨日界在 UTC 上算', () => {
    expect(utcDayKey(new Date('2026-09-23T03:15:00Z'))).toBe('2026-09-23')
    expect(utcDayKey(new Date('2026-09-23T23:59:59.999Z'))).toBe('2026-09-23')
    expect(utcDayKey(new Date('2026-09-24T00:00:00Z'))).toBe('2026-09-24')
    // 本地时间口径（东京 +9 的 09-24 早上）不能影响 UTC 日键。
    expect(utcDayKey(new Date('2026-09-24T00:00:00+09:00'))).toBe('2026-09-23')
  })

  it('片名日键与片名时刻同口径', () => {
    const parsed = parseLogShardName(logShardName('runtime', AT, false))
    expect(parsed).not.toBeNull()
    expect(utcDayKeyOfShard(parsed!)).toBe('2026-09-23')
  })
})

describe('compareLogShards', () => {
  it('按 (解析出的 at, 文件名) 升序：同刻用文件名定序（`_2` 在后）', () => {
    const entries = [
      { name: 'runtime-20260923T031501Z.jsonl', parsed: parseLogShardName('runtime-20260923T031501Z.jsonl')! },
      { name: 'runtime-20260923T031500Z_2.jsonl', parsed: parseLogShardName('runtime-20260923T031500Z_2.jsonl')! },
      { name: 'runtime-20260923T031500Z.jsonl', parsed: parseLogShardName('runtime-20260923T031500Z.jsonl')! },
    ]
    expect([...entries].sort(compareLogShards).map((entry) => entry.name)).toEqual([
      'runtime-20260923T031500Z.jsonl',
      'runtime-20260923T031500Z_2.jsonl',
      'runtime-20260923T031501Z.jsonl',
    ])
  })

  it('不靠纯文件名字典序：解析出的 at 才是主键', () => {
    // 压缩片的 `.gz` 后缀会让纯文件名比较把它排在同刻源片之后，at 相同时才轮到文件名。
    const source = { name: 'runtime-20260923T031500Z.jsonl', parsed: parseLogShardName('runtime-20260923T031500Z.jsonl')! }
    const gzipped = { name: 'runtime-20260923T031500Z.jsonl.gz', parsed: parseLogShardName('runtime-20260923T031500Z.jsonl.gz')! }
    const older = { name: 'runtime-20260922T000000Z.jsonl.gz', parsed: parseLogShardName('runtime-20260922T000000Z.jsonl.gz')! }
    const sorted = [gzipped, source, older].sort(compareLogShards).map((entry) => entry.name)
    expect(sorted).toEqual([
      'runtime-20260922T000000Z.jsonl.gz',
      'runtime-20260923T031500Z.jsonl',
      'runtime-20260923T031500Z.jsonl.gz',
    ])
  })
})
