import { describe, expect, it } from 'vitest'
import {
  UI_PREFERENCES_KEY,
  clearStoredTheme,
  readStoredTheme,
  writeStoredTheme,
} from './themePreferences'

function fakeStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries))
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

describe('界面偏好存储', () => {
  it('写入的是带版本号与时间戳的结构化数据，读回同一个取值', () => {
    const storage = fakeStorage()
    writeStoredTheme(storage, 'light', '2026-09-15T00:00:00.000Z')

    expect(storage.map.get(UI_PREFERENCES_KEY)).toBe(
      '{"version":1,"theme":"light","savedAt":"2026-09-15T00:00:00.000Z"}',
    )
    expect(readStoredTheme(storage)).toBe('light')
  })

  it('没有存过偏好时读不到值', () => {
    expect(readStoredTheme(fakeStorage())).toBeNull()
  })

  it('内容不是合法 JSON、版本不认识或主题取值不认识时回落 null', () => {
    expect(readStoredTheme(fakeStorage({ [UI_PREFERENCES_KEY]: 'light' }))).toBeNull()
    expect(readStoredTheme(fakeStorage({ [UI_PREFERENCES_KEY]: '{"version":2,"theme":"dark"}' }))).toBeNull()
    expect(readStoredTheme(fakeStorage({ [UI_PREFERENCES_KEY]: '{"version":1,"theme":"neon"}' }))).toBeNull()
    expect(readStoredTheme(fakeStorage({ [UI_PREFERENCES_KEY]: '[]' }))).toBeNull()
  })

  it('清掉偏好之后回到未存过的状态', () => {
    const storage = fakeStorage()
    writeStoredTheme(storage, 'dark', '2026-09-15T00:00:00.000Z')
    clearStoredTheme(storage)
    expect(readStoredTheme(storage)).toBeNull()
  })
})
