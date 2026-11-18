import { expect, it } from 'vitest'
import { formatBytes, formatFromMiB } from './formatBytes'

it('区分十进制、IEC 和旧标签的进位规则', () => {
  expect(formatBytes(1000, { unit: 'si' })).toBe('1.0 kB')
  expect(formatBytes(1000)).toBe('1000 B')
  expect(formatBytes(1024)).toBe('1.0 KiB')
  expect(formatBytes(1024, { unit: 'legacy' })).toBe('1.0 KB')
})

it('先按原始值选单位，再应用该单位的舍入方式', () => {
  expect(formatBytes(1025, { digits: { kilo: 'ceil' } })).toBe('2 KiB')
  expect(formatBytes(1025, { digits: { kilo: 'round' } })).toBe('1 KiB')
  expect(formatBytes(1024 ** 2 - 1)).toBe('1024.0 KiB')
  expect(formatBytes(1024 ** 2)).toBe('1.0 MiB')
})

it('仅在调用方指定时限制最小和最大单位', () => {
  expect(formatBytes(50, { unit: 'legacy', minUnit: 'kilo', digits: { kilo: 'round' } })).toBe('0 KB')
  expect(formatBytes(50, { unit: 'legacy', digits: { byte: 'round' } })).toBe('50 B')
  expect(formatBytes(1024 ** 3, { maxUnit: 'mega' })).toBe('1024.0 MiB')
  expect(formatBytes(1024 ** 3)).toBe('1.0 GiB')
})

it('MiB 输入保留原单位或在达到阈值后进位', () => {
  expect(formatFromMiB(0.25)).toBe('0.3 MiB')
  expect(formatFromMiB(1024, { maxUnit: 'mega' })).toBe('1024.0 MiB')
  expect(formatFromMiB(1536, { digits: { giga: 2 } })).toBe('1.50 GiB')
  expect(formatFromMiB(12.375, { unit: 'legacy', digits: { mega: 'raw' } })).toBe('12.375 MB')
  expect(formatFromMiB(1536, { unit: 'legacy', digits: { mega: 'raw' } })).toBe('1.5 GB')
})
