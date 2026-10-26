import { describe, expect, it, vi } from 'vitest'
import { resilientPreferenceStorage } from './preferenceStorage'

describe('可降级的界面偏好存储', () => {
  it('存储 getter 被策略禁止时仍能读写页内偏好，连续失败仅提示一次', () => {
    const warn = vi.fn()
    const storage = resilientPreferenceStorage(() => { throw new DOMException('blocked', 'SecurityError') }, warn)
    expect(storage.getItem('ui')).toBeNull()
    storage.setItem('ui', 'light')
    expect(storage.getItem('ui')).toBe('light')
    storage.setItem('ui', 'dark')
    expect(storage.getItem('ui')).toBe('dark')
    storage.removeItem('ui')
    expect(storage.getItem('ui')).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
  })
  it('可读但写入超额时不回灌旧值，恢复后保存最新偏好并开启下一轮通知', () => {
    let raw: string | null = 'old'
    let blocked = true
    const warn = vi.fn()
    const storage = resilientPreferenceStorage(() => ({
      getItem: () => raw,
      setItem: (_key, value) => { if (blocked) throw new DOMException('full', 'QuotaExceededError'); raw = value },
      removeItem: () => { if (blocked) throw new Error('blocked'); raw = null },
    }), warn)
    expect(storage.getItem('ui')).toBe('old')
    storage.setItem('ui', 'unsaved')
    expect(raw).toBe('old')
    expect(storage.getItem('ui')).toBe('unsaved')
    blocked = false
    storage.setItem('ui', 'latest')
    expect(raw).toBe('latest')
    blocked = true
    storage.removeItem('ui')
    expect(storage.getItem('ui')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
