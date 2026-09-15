import { describe, expect, it } from 'vitest'
import { formatUptime } from './format'

describe('通用格式化', () => {
  it('运行时长按天/小时/分钟分档，未启动显示 —', () => {
    const now = new Date('2026-09-12T12:00:00.000Z')
    expect(formatUptime('2026-09-09T10:30:00.000Z', now)).toBe('3 天 1 小时')
    expect(formatUptime('2026-09-12T09:30:00.000Z', now)).toBe('2 小时')
    expect(formatUptime('2026-09-12T11:20:00.000Z', now)).toBe('40 分钟')
    expect(formatUptime(undefined, now)).toBe('—')
  })
})
