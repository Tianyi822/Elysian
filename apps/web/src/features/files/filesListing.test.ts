import { describe, expect, it } from 'vitest'
import { formatEntrySize, orderFileEntries } from './filesListing'
import type { FileEntry } from '@elysian/contracts'

function entry(name: string, kind: 'directory' | 'file', sizeBytes?: number): FileEntry {
  return { name, kind, mode: '755', owner: 'root', sizeBytes, modifiedAt: '2026-09-10T08:30:00+08:00' }
}

describe('目录条目排序', () => {
  it('文件夹排在文件前面，各自按名称升序', () => {
    const ordered = orderFileEntries([
      entry('syslog', 'file', 1024),
      entry('nginx', 'directory'),
      entry('auth.log', 'file', 512),
      entry('journal', 'directory'),
      entry('boot', 'directory'),
    ])
    expect(ordered.map((item) => item.name)).toEqual(['boot', 'journal', 'nginx', 'auth.log', 'syslog'])
  })

  it('不改动传入的数组', () => {
    const input = [entry('b', 'file', 1), entry('a', 'directory')]
    orderFileEntries(input)
    expect(input.map((item) => item.name)).toEqual(['b', 'a'])
  })
})

describe('条目大小格式化', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
    [2.5 * 1024 * 1024, '2.5 MB'],
    [1024 ** 3, '1.0 GB'],
    [3.2 * 1024 ** 3, '3.2 GB'],
  ])('%d 字节显示为 %s', (bytes, expected) => {
    expect(formatEntrySize(bytes)).toBe(expected)
  })

  it('KB 以上不足一位小数时补齐，不出现「1 KB」与「1.0 KB」并存', () => {
    expect(formatEntrySize(1200)).toBe('1.2 KB')
    expect(formatEntrySize(1024 * 1024 * 47)).toBe('47.0 MB')
  })
})
