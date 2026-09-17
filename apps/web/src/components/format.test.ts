import { describe, expect, it } from 'vitest'
import { formatByteSize, formatLoginTime, formatUptime } from './format'

describe('通用格式化', () => {
  it('运行时长按天/小时/分钟分档，未启动显示 —', () => {
    const now = new Date('2026-09-12T12:00:00.000Z')
    expect(formatUptime('2026-09-09T10:30:00.000Z', now)).toBe('3 天 1 小时')
    expect(formatUptime('2026-09-12T09:30:00.000Z', now)).toBe('2 小时')
    expect(formatUptime('2026-09-12T11:20:00.000Z', now)).toBe('40 分钟')
    expect(formatUptime(undefined, now)).toBe('—')
  })

  it('登录时间精确到秒并带连字符，固定时区因此与机器设置无关', () => {
    expect(formatLoginTime('2026-09-07T06:10:53.000Z')).toBe('2026-09-07 14:10:53')
    expect(formatLoginTime('2026-09-07T14:10:53+08:00')).toBe('2026-09-07 14:10:53')
  })
})

describe('formatByteSize', () => {
  it('字节格式化为 KB/MB，保留两位小数', () => {
    expect(formatByteSize(0)).toBe('0.00 KB')
    expect(formatByteSize(13_713)).toBe('13.39 KB')
    expect(formatByteSize(1_572_864)).toBe('1.50 MB')
  })
})
