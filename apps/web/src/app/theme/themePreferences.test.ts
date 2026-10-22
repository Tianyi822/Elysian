import { describe, expect, it } from 'vitest'
import {
  UI_PREFERENCES_KEY,
  clearStoredTheme,
  readMutedDependencyGuide,
  readStoredNavOrder,
  readStoredTheme,
  writeMutedDependencyGuide,
  writeStoredNavOrder,
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

  it('旧版本遗留的页签字段被忽略：主题与导航顺序照常可读，再写入时整体消失', () => {
    const storage = fakeStorage({
      [UI_PREFERENCES_KEY]:
        '{"version":1,"theme":"dark","savedAt":"2026-09-15T00:00:00.000Z","tabs":{"security":"ssh"},"nav":["/logs"]}',
    })

    expect(readStoredTheme(storage)).toBe('dark')
    expect(readStoredNavOrder(storage)).toEqual(['/logs'])

    writeStoredTheme(storage, 'light', '2026-10-22T00:00:00.000Z')
    expect(JSON.parse(storage.map.get(UI_PREFERENCES_KEY) ?? '{}')).not.toHaveProperty('tabs')
  })
})

describe('导航顺序存储', () => {
  it('导航顺序与主题共存；改其中一项不会丢掉其余', () => {
    const storage = fakeStorage()
    writeStoredTheme(storage, 'dark', '2026-09-15T00:00:00.000Z')
    writeStoredNavOrder(storage, ['/files', '/security', '/'], '2026-09-21T03:00:00.000Z')

    expect(readStoredTheme(storage)).toBe('dark')
    expect(readStoredNavOrder(storage)).toEqual(['/files', '/security', '/'])

    writeStoredTheme(storage, 'light', '2026-09-21T04:00:00.000Z')
    expect(readStoredNavOrder(storage)).toEqual(['/files', '/security', '/'])
  })

  it('跟随系统只清主题，已存导航顺序仍在；只剩导航顺序时也不整份删掉', () => {
    const storage = fakeStorage()
    writeStoredTheme(storage, 'light', '2026-09-15T00:00:00.000Z')
    writeStoredNavOrder(storage, ['/websites', '/'], '2026-09-21T03:00:00.000Z')
    clearStoredTheme(storage)

    expect(readStoredTheme(storage)).toBeNull()
    expect(readStoredNavOrder(storage)).toEqual(['/websites', '/'])

    const navOnly = fakeStorage()
    writeStoredNavOrder(navOnly, ['/logs'], '2026-09-21T03:00:00.000Z')
    clearStoredTheme(navOnly)
    expect(readStoredNavOrder(navOnly)).toEqual(['/logs'])
  })

  it('导航顺序不是字符串数组、版本不认识或还没存过时读到 null', () => {
    expect(readStoredNavOrder(fakeStorage())).toBeNull()
    expect(
      readStoredNavOrder(fakeStorage({ [UI_PREFERENCES_KEY]: '{"version":2,"nav":["/"]}' })),
    ).toBeNull()
    expect(
      readStoredNavOrder(fakeStorage({ [UI_PREFERENCES_KEY]: '{"version":1,"nav":"/"}' })),
    ).toBeNull()
    expect(
      readStoredNavOrder(fakeStorage({ [UI_PREFERENCES_KEY]: '{"version":1,"nav":["/",1]}' })),
    ).toEqual(['/'])
  })
})

describe('依赖引导不再提示', () => {
  it('记下之后刷新仍在，改主题或跟随系统都不会丢掉', () => {
    const storage = fakeStorage()
    writeMutedDependencyGuide(storage, 'caddy', true, '2026-09-29T00:00:00.000Z')
    expect(readMutedDependencyGuide(storage, 'caddy')).toBe(true)
    expect(readMutedDependencyGuide(storage, 'docker')).toBe(false)

    writeStoredTheme(storage, 'dark', '2026-09-29T01:00:00.000Z')
    expect(readMutedDependencyGuide(storage, 'caddy')).toBe(true)
    expect(readStoredTheme(storage)).toBe('dark')

    clearStoredTheme(storage)
    expect(readStoredTheme(storage)).toBeNull()
    expect(readMutedDependencyGuide(storage, 'caddy')).toBe(true)

    writeMutedDependencyGuide(storage, 'caddy', false, '2026-09-29T02:00:00.000Z')
    expect(readMutedDependencyGuide(storage, 'caddy')).toBe(false)
    expect(storage.map.has(UI_PREFERENCES_KEY)).toBe(false)
  })
})
