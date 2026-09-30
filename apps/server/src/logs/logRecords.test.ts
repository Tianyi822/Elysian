import { describe, expect, it } from 'vitest'
import {
  LOG_MESSAGE_MAX_LENGTH,
  LOG_RECORD_MAX_BYTES,
  LOG_SOURCE_MAX_LENGTH,
  LOG_TRUNCATION_MARKER,
  isRecordOversize,
  logRecordId,
  normalizeSingleLine,
  parseOperationLogLine,
  parseRuntimeLogLine,
  toOperationLogEntry,
  toRuntimeLogEntry,
  utf8ByteLength,
  type OperationLogRecord,
  type RuntimeLogRecord,
} from './logRecords'

/*
 * 记录层的纯行为测试：单行化（U+2028 / U+2029 / U+0085 三条独立用例）、
 * 64 KiB 硬闸、坏行与形状不合法、id 生成与条目转换。全部纯函数，不碰文件系统、不读时钟。
 */

const RUNTIME: RuntimeLogRecord = {
  at: '2026-09-23T03:24:54.123Z',
  seq: 10241,
  level: 'info',
  source: 'server.lifecycle',
  message: 'Elysian 服务已启动：http://127.0.0.1:48101',
}

const OPERATION: OperationLogRecord = {
  at: '2026-09-23T03:25:10.004Z',
  seq: 7,
  category: 'security',
  action: '修改 SSH 监听端口',
  target: 'sshd',
  result: 'success',
  httpStatus: 200,
  method: 'PUT',
  path: '/api/security/ssh/port',
  summary: '端口 2222',
}

describe('normalizeSingleLine', () => {
  it('剥换行、制表、DEL 与 C1 控制字符，连续空白压成一个空格后 trim', () => {
    expect(normalizeSingleLine('a\nb', 100)).toBe('a b')
    expect(normalizeSingleLine('  两行\r\n文本\t ', 100)).toBe('两行 文本')
    expect(normalizeSingleLine('a\u0000b\u007Fc', 100)).toBe('a b c')
  })

  it('U+0085（NEL）不切行但同样不出现在正文里', () => {
    expect(normalizeSingleLine('a\u0085b', 100)).toBe('a b')
    expect(normalizeSingleLine('a\u0085b', 100)).not.toContain('\u0085')
  })

  it('U+2028（LINE SEPARATOR）被剥——JSON.stringify 不转义它，漏掉会让读侧切成两行', () => {
    const text = 'a\u2028b'
    expect(normalizeSingleLine(text, 100)).toBe('a b')
    // 反证：JSON.stringify 原样保留裸字符（这正是必须在写入前剥掉的原因）。
    expect(JSON.stringify({ m: text })).toContain('\u2028')
  })

  it('U+2029（PARAGRAPH SEPARATOR）同样被剥', () => {
    expect(normalizeSingleLine('a\u2029b', 100)).toBe('a b')
    expect(JSON.stringify({ m: 'a\u2029b' })).toContain('\u2029')
  })

  it('超长截断：保留正文 + 标记，总长不超过上限', () => {
    const long = 'a'.repeat(LOG_MESSAGE_MAX_LENGTH + 50)
    const normalized = normalizeSingleLine(long, LOG_MESSAGE_MAX_LENGTH)
    expect(normalized.length).toBe(LOG_MESSAGE_MAX_LENGTH)
    expect(normalized.endsWith(LOG_TRUNCATION_MARKER)).toBe(true)
    expect(normalized.slice(0, -LOG_TRUNCATION_MARKER.length)).toBe(
      'a'.repeat(LOG_MESSAGE_MAX_LENGTH - LOG_TRUNCATION_MARKER.length),
    )
  })

  it('恰好等于上限不截断；上限小到装不下标记时退化为纯截断', () => {
    expect(normalizeSingleLine('a'.repeat(200), 200)).toBe('a'.repeat(200))
    expect(normalizeSingleLine('abcdefghij', 3)).toBe('abc')
  })
})

describe('单条记录硬闸', () => {
  it('上限内（含上限本身）放行，超一个字节即丢弃', () => {
    expect(LOG_RECORD_MAX_BYTES).toBe(64 * 1024)
    expect(isRecordOversize('a'.repeat(LOG_RECORD_MAX_BYTES))).toBe(false)
    expect(isRecordOversize('a'.repeat(LOG_RECORD_MAX_BYTES + 1))).toBe(true)
    // 中文字符按 UTF-8 三字节计。
    expect(utf8ByteLength('中')).toBe(3)
  })

  it('正常记录（含最长 message）远在硬闸之内', () => {
    const line = JSON.stringify({
      ...RUNTIME,
      message: '中'.repeat(LOG_MESSAGE_MAX_LENGTH),
    })
    expect(utf8ByteLength(line)).toBeLessThan(LOG_RECORD_MAX_BYTES)
    expect(isRecordOversize(line)).toBe(false)
  })
})

describe('parseRuntimeLogLine', () => {
  it('坏行、非对象、缺字段、类型不符都返回 null', () => {
    for (const line of [
      '',
      'not json',
      '{"at":"2026-09-23T03:24:54.123Z","seq":1,"level":"info","source":"a"',
      '[]',
      '42',
      JSON.stringify({ seq: 1, level: 'info', source: 'a', message: 'b' }),
      JSON.stringify({ at: 'N/A', seq: 1, level: 'info', source: 'a', message: 'b' }),
      JSON.stringify({ at: '2026-09-23T03:24:54.123Z', seq: 1.5, level: 'info', source: 'a', message: 'b' }),
      JSON.stringify({ at: '2026-09-23T03:24:54.123Z', seq: 1, level: 'fatal', source: 'a', message: 'b' }),
      JSON.stringify({ at: '2026-09-23T03:24:54.123Z', seq: 1, level: 'info', source: 1, message: 'b' }),
      JSON.stringify({ at: '2026-09-23T03:24:54.123Z', seq: 1, level: 'info', source: 'a', message: null }),
    ]) {
      expect(parseRuntimeLogLine(line)).toBeNull()
    }
  })

  it('合法行往返一致，多余字段不进记录（形状收敛到已知字段）', () => {
    const line = JSON.stringify(RUNTIME)
    expect(parseRuntimeLogLine(line)).toEqual(RUNTIME)
    expect(parseRuntimeLogLine(`${line.slice(0, -1)},"extra":1}`)).toEqual(RUNTIME)
  })

  it('半行（崩溃残行）解析失败但不影响其它行', () => {
    const line = JSON.stringify(RUNTIME)
    const truncated = line.slice(0, line.length - 20)
    expect(parseRuntimeLogLine(truncated)).toBeNull()
    expect(parseRuntimeLogLine(line)).toEqual(RUNTIME)
  })
})

describe('parseOperationLogLine', () => {
  it('合法行往返一致，多余字段不进记录', () => {
    const line = JSON.stringify(OPERATION)
    expect(parseOperationLogLine(line)).toEqual(OPERATION)
    expect(parseOperationLogLine(`${line.slice(0, -1)},"actor":"panel"}`)).toEqual(OPERATION)
  })

  it('缺字段、类别越界、结果越界、httpStatus 非整数都返回 null', () => {
    const base = OPERATION as unknown as Record<string, unknown>
    const without = (key: string): string => {
      const copy = { ...base }
      delete copy[key]
      return JSON.stringify(copy)
    }
    for (const line of [
      without('summary'),
      without('httpStatus'),
      JSON.stringify({ ...base, category: 'database2' }),
      JSON.stringify({ ...base, result: 'unknown' }),
      JSON.stringify({ ...base, httpStatus: '200' }),
      JSON.stringify({ ...base, target: 7 }),
      JSON.stringify({ ...base, method: undefined }),
    ]) {
      expect(parseOperationLogLine(line)).toBeNull()
    }
  })

  it('null 字段是合法形状（无对象、无参数、非 HTTP 触发）', () => {
    const record: OperationLogRecord = {
      ...OPERATION,
      category: 'terminals',
      action: '打开本机终端会话',
      target: null,
      summary: '',
      httpStatus: null,
      method: null,
      path: null,
    }
    expect(parseOperationLogLine(JSON.stringify(record))).toEqual(record)
  })
})

describe('id 与条目转换', () => {
  it('id 形如 `<at>#<seq>`，同一响应内唯一', () => {
    expect(logRecordId('2026-09-23T03:24:54.123Z', 10241)).toBe('2026-09-23T03:24:54.123Z#10241')
    const entries = [RUNTIME, { ...RUNTIME, seq: RUNTIME.seq + 1 }].map(toRuntimeLogEntry)
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2)
  })

  it('运行日志条目 = 记录 + id（字段原样）', () => {
    expect(toRuntimeLogEntry(RUNTIME)).toEqual({
      id: '2026-09-23T03:24:54.123Z#10241',
      at: RUNTIME.at,
      level: RUNTIME.level,
      source: RUNTIME.source,
      message: RUNTIME.message,
    })
  })

  it('操作日志条目 = 记录 + id（字段原样，含 null）', () => {
    expect(toOperationLogEntry({ ...OPERATION, target: null, httpStatus: null, method: null, path: null })).toEqual({
      id: '2026-09-23T03:25:10.004Z#7',
      at: OPERATION.at,
      category: OPERATION.category,
      action: OPERATION.action,
      target: null,
      summary: OPERATION.summary,
      result: OPERATION.result,
      method: null,
      path: null,
      httpStatus: null,
    })
  })

  it('LOG_SOURCE_MAX_LENGTH 与契约的 source 语义同值（净化面的一致口径）', () => {
    expect(LOG_SOURCE_MAX_LENGTH).toBe(64)
  })
})
