import { describe, expect, it } from 'vitest'
import { LOG_ENTRY_FETCH_LIMIT, type PlatformLogCategory } from '@elysian/contracts'
import { parseRuntimeLogLine, serializeRuntimeLogRecord, type RuntimeLogRecord } from './logRecords'
import { LOG_READ_MAX_RECORDS, readLogRecords, type LogFileRef, type LogReaderDeps } from './logReader'

/*
 * 读取器的行为测试（全部用可观测的 fake deps，不碰文件系统、不读时钟）：
 * 升序拼流、内存有界且结果无空洞（旧文件很大 + 新文件很小是丢错端会暴露空洞的场景）、
 * (at, seq) 排序（含 `_2` 后缀片）、坏行计数、坏文件降级、按 id 去重、空目录。
 * 真实 fs 与 .gz 读回由 logsHostDeps.test.ts 的冒烟用例覆盖。
 */

const AT = '2026-09-23T03:00:00.000Z'

function record(seq: number, at = AT, message = `第 ${seq} 条`): RuntimeLogRecord {
  return { at, seq, level: 'info', source: 'logs.test', message }
}

function linesOf(records: readonly RuntimeLogRecord[]): string[] {
  return records.map(serializeRuntimeLogRecord)
}

type FakeFile = {
  name: string
  lines: string[]
  /** 读到一半失败（模拟 .gz 损坏、EACCES、ENOENT 竞态）。 */
  fail?: boolean
  sizeBytes?: number
}

type FakeDeps = LogReaderDeps<RuntimeLogRecord> & {
  readPaths: string[]
  lineCounts: Map<string, number>
}

function createFakeDeps(files: readonly FakeFile[]): FakeDeps {
  const byPath = new Map(files.map((file) => [`/logs/${file.name}`, file]))
  const readPaths: string[] = []
  const lineCounts = new Map<string, number>()
  return {
    readPaths,
    lineCounts,
    listFiles: async (category: PlatformLogCategory): Promise<readonly LogFileRef[]> =>
      files
        .filter((file) => parseLogShardNameCategory(file.name) === category)
        .map((file) => ({
          path: `/logs/${file.name}`,
          name: file.name,
          sizeBytes: file.sizeBytes ?? file.lines.join('\n').length,
        })),
    readLines: async (path, onLine) => {
      const file = byPath.get(path)
      if (file === undefined) throw new Error(`ENOENT: ${path}`)
      readPaths.push(path)
      for (const line of file.lines) {
        if (file.fail) throw new Error('Z_DATA_ERROR')
        lineCounts.set(path, (lineCounts.get(path) ?? 0) + 1)
        onLine(line)
      }
      if (file.fail) throw new Error('Z_DATA_ERROR')
    },
    parseLine: parseRuntimeLogLine,
  }
}

/** 测试内的名字 → 类别判定（与 logsPaths 的口径一致，但只看前缀，语义足够）。 */
function parseLogShardNameCategory(name: string): PlatformLogCategory | null {
  if (name.startsWith('runtime-')) return 'runtime'
  if (name.startsWith('operation-')) return 'operation'
  return null
}

describe('把分片拼回一条升序流', () => {
  it('多文件（含 .jsonl.gz 与 `_2` 后缀）按时序拼成一条升序流', async () => {
    const deps = createFakeDeps([
      { name: 'runtime-20260922T000000Z.jsonl.gz', lines: linesOf([record(1, '2026-09-22T00:00:00.000Z')]) },
      { name: 'runtime-20260923T010000Z_2.jsonl', lines: linesOf([record(3, '2026-09-23T01:00:00.000Z')]) },
      { name: 'runtime-20260923T010000Z.jsonl', lines: linesOf([record(2, '2026-09-23T01:00:00.000Z')]) },
      { name: 'sshd.log', lines: ['不属于本模块的文件'] },
      { name: 'runtime-20260923T031500Z.jsonl.gz.tmp', lines: ['压缩残留'] },
    ])

    const result = await readLogRecords(deps, 'runtime', LOG_ENTRY_FETCH_LIMIT)

    expect(result.records.map((item) => item.seq)).toEqual([1, 2, 3])
    // 同刻（01:00:00）的两片按文件名定序：基名在前、`_2` 在后，且 seq 也递增。
    expect(result.records.map((item) => item.at)).toEqual([
      '2026-09-22T00:00:00.000Z',
      '2026-09-23T01:00:00.000Z',
      '2026-09-23T01:00:00.000Z',
    ])
    expect(result).toMatchObject({ truncated: false, skippedLines: 0, skippedFiles: 0 })
    // 非本模块的文件既不出现在结果里，也不被读取。
    expect(deps.readPaths).toEqual([
      '/logs/runtime-20260923T010000Z_2.jsonl',
      '/logs/runtime-20260923T010000Z.jsonl',
      '/logs/runtime-20260922T000000Z.jsonl.gz',
    ])
  })

  it('同一毫秒跨两片：按 (at, seq) 升序，不靠文件名字典序', async () => {
    const deps = createFakeDeps([
      // 名字更大的片里放的是更小的 seq（外部植入的乱序），排序后仍按 seq 归位。
      { name: 'runtime-20260923T010000Z.jsonl', lines: linesOf([record(9, AT)]) },
      { name: 'runtime-20260923T010000Z_2.jsonl', lines: linesOf([record(4, AT)]) },
    ])
    const result = await readLogRecords(deps, 'runtime', 10)
    expect(result.records.map((item) => item.seq)).toEqual([4, 9])
  })

  it('空目录返回空列表（不是错误）', async () => {
    const deps = createFakeDeps([])
    const result = await readLogRecords(deps, 'runtime', 10)
    expect(result).toEqual({ records: [], truncated: false, skippedLines: 0, skippedFiles: 0 })
  })

  it('只读该类别的片：另一个类别的文件不参与', async () => {
    const deps = createFakeDeps([
      { name: 'operation-20260923T010000Z.jsonl', lines: ['{"at":"2026-09-23T01:00:00.000Z","seq":1,"level":"info","source":"a","message":"b"}'] },
    ])
    const result = await readLogRecords(deps, 'runtime', 10)
    expect(result.records).toEqual([])
    expect(deps.readPaths).toEqual([])
  })
})

describe('内存有界且结果无空洞', () => {
  it('旧文件 30000 条 + 新文件 100 条：返回最近 limit 条且内部单调无缺口', async () => {
    const oldRecords = Array.from({ length: 30_000 }, (_, index) =>
      record(index + 1, new Date(Date.UTC(2026, 8, 22, 0, 0, 0) + index * 1000).toISOString()),
    )
    const newRecords = Array.from({ length: 100 }, (_, index) =>
      record(30_001 + index, new Date(Date.UTC(2026, 8, 23, 0, 0, 0) + index * 1000).toISOString()),
    )
    const deps = createFakeDeps([
      { name: 'runtime-20260922T000000Z.jsonl', lines: linesOf(oldRecords) },
      { name: 'runtime-20260923T000000Z.jsonl', lines: linesOf(newRecords) },
    ])

    const result = await readLogRecords(deps, 'runtime', LOG_ENTRY_FETCH_LIMIT)

    expect(result.records).toHaveLength(LOG_ENTRY_FETCH_LIMIT)
    expect(result.records.map((item) => item.seq)).toEqual(
      Array.from({ length: LOG_ENTRY_FETCH_LIMIT }, (_, index) => 29_101 + index),
    )
    // 无缺口：既单调递增，也无跳号（丢错端的写法会在中间出现断口）。
    const seqs = result.records.map((item) => item.seq)
    expect(seqs.every((seq, index) => index === 0 || seq === seqs[index - 1]! + 1)).toBe(true)
    expect(result.truncated).toBe(true)
    // 两个文件都整份读完（要拿尾部就必须读到 EOF）。
    expect(deps.readPaths).toHaveLength(2)
    expect(deps.lineCounts.get('/logs/runtime-20260922T000000Z.jsonl')).toBe(30_000)
  })

  it('acc 达到硬上限后不再读更旧的文件', async () => {
    const files = [
      { name: 'runtime-20260921T000000Z.jsonl', lines: linesOf(Array.from({ length: 5_000 }, (_, i) => record(i + 1))) },
      { name: 'runtime-20260922T000000Z.jsonl', lines: linesOf(Array.from({ length: LOG_READ_MAX_RECORDS }, (_, i) => record(10_000 + i))) },
      { name: 'runtime-20260923T000000Z.jsonl', lines: linesOf([record(99_999)]) },
    ]
    const deps = createFakeDeps(files)

    const result = await readLogRecords(deps, 'runtime', LOG_ENTRY_FETCH_LIMIT)

    // 最新两个文件就填满了硬上限，最旧的那个整份不读。
    expect(deps.readPaths).not.toContain('/logs/runtime-20260921T000000Z.jsonl')
    expect(deps.readPaths).toHaveLength(2)
    expect(result.truncated).toBe(true)
    expect(result.records.at(-1)?.seq).toBe(99_999)
  })

  it('单个文件超过硬上限：只保留该文件最新的 cap 条（内存上界由环形缓冲保证）', async () => {
    const total = LOG_READ_MAX_RECORDS + 5_000
    const deps = createFakeDeps([
      { name: 'runtime-20260923T000000Z.jsonl', lines: linesOf(Array.from({ length: total }, (_, i) => record(i + 1))) },
    ])

    const result = await readLogRecords(deps, 'runtime', LOG_READ_MAX_RECORDS)

    expect(result.records).toHaveLength(LOG_READ_MAX_RECORDS)
    expect(result.records[0]?.seq).toBe(5_001)
    expect(result.records.at(-1)?.seq).toBe(total)
    expect(result.truncated).toBe(true)
  })
})

describe('limit 与 truncated', () => {
  it('恰好等于 limit 条不标截断；多一条即标截断并只回最近 limit 条', async () => {
    const exact = createFakeDeps([
      { name: 'runtime-20260923T000000Z.jsonl', lines: linesOf(Array.from({ length: 3 }, (_, i) => record(i + 1))) },
    ])
    expect(await readLogRecords(exact, 'runtime', 3)).toMatchObject({ truncated: false })
    expect((await readLogRecords(exact, 'runtime', 3)).records.map((item) => item.seq)).toEqual([1, 2, 3])

    const over = createFakeDeps([
      { name: 'runtime-20260923T000000Z.jsonl', lines: linesOf(Array.from({ length: 4 }, (_, i) => record(i + 1))) },
    ])
    const result = await readLogRecords(over, 'runtime', 3)
    expect(result.truncated).toBe(true)
    expect(result.records.map((item) => item.seq)).toEqual([2, 3, 4])
  })
})

describe('坏行与坏文件', () => {
  it('坏行计入 skippedLines 并跳过，其余行照常返回', async () => {
    const deps = createFakeDeps([
      {
        name: 'runtime-20260923T000000Z.jsonl',
        lines: [
          serializeRuntimeLogRecord(record(1)),
          'not json',
          '{"at":"2026-09-23T00:00:01.000Z","seq":2,"level":"info","source":"a"',
          JSON.stringify({ at: AT, seq: 3, level: 'fatal', source: 'a', message: 'b' }),
          serializeRuntimeLogRecord(record(4)),
        ],
      },
    ])

    const result = await readLogRecords(deps, 'runtime', 10)

    expect(result.skippedLines).toBe(3)
    expect(result.skippedFiles).toBe(0)
    expect(result.records.map((item) => item.seq)).toEqual([1, 4])
  })

  it('单个文件读失败（.gz 损坏）只计入 skippedFiles，其余文件照读', async () => {
    const deps = createFakeDeps([
      { name: 'runtime-20260923T000000Z.jsonl', lines: linesOf([record(1)]) },
      { name: 'runtime-20260922T000000Z.jsonl.gz', lines: ['半截'], fail: true },
      { name: 'runtime-20260921T000000Z.jsonl', lines: linesOf([record(3, '2026-09-21T00:00:00.000Z')]) },
    ])

    const result = await readLogRecords(deps, 'runtime', 10)

    expect(result.skippedFiles).toBe(1)
    expect(result.skippedLines).toBe(0)
    expect(result.records.map((item) => item.seq)).toEqual([3, 1])
  })
})

describe('按 id 去重', () => {
  it('压缩 rename 后 unlink 前的并存窗口：同一片两形态先后读到，只保留一条', async () => {
    const lines = linesOf([record(1), record(2)])
    const deps = createFakeDeps([
      { name: 'runtime-20260923T000000Z.jsonl', lines },
      { name: 'runtime-20260923T000000Z.jsonl.gz', lines },
    ])

    const result = await readLogRecords(deps, 'runtime', 10)

    expect(result.records.map((item) => item.seq)).toEqual([1, 2])
    expect(result.records).toHaveLength(2)
  })

  it('不同片里的重复 (at, seq) 只保留一条', async () => {
    const deps = createFakeDeps([
      { name: 'runtime-20260923T000000Z.jsonl', lines: linesOf([record(1), record(2)]) },
      { name: 'runtime-20260923T000000Z_2.jsonl', lines: linesOf([record(2)]) },
    ])
    const result = await readLogRecords(deps, 'runtime', 10)
    expect(result.records.map((item) => item.seq)).toEqual([1, 2])
  })
})
