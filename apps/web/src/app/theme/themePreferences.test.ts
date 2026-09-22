import { describe, expect, it } from 'vitest'
import {
  UI_PREFERENCES_KEY,
  clearStoredTheme,
  readStoredNavOrder,
  readStoredTheme,
  readStoredViewTab,
  resolveViewTab,
  writeStoredNavOrder,
  writeStoredTheme,
  writeStoredViewTab,
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

describe('页签偏好存储', () => {
  it('写入页签后能按键读回，并与主题共存于同一份结构化数据', () => {
    const storage = fakeStorage()
    writeStoredTheme(storage, 'dark', '2026-09-15T00:00:00.000Z')
    writeStoredViewTab(storage, 'security', 'ssh', '2026-09-21T00:00:00.000Z')

    expect(readStoredTheme(storage)).toBe('dark')
    expect(readStoredViewTab(storage, 'security')).toBe('ssh')
    expect(JSON.parse(storage.map.get(UI_PREFERENCES_KEY) ?? '{}')).toMatchObject({
      version: 1,
      theme: 'dark',
      tabs: { security: 'ssh' },
    })
  })

  it('改主题不会丢掉已存页签；改页签不会丢掉已存主题', () => {
    const storage = fakeStorage()
    writeStoredViewTab(storage, 'logs', 'login', '2026-09-21T00:00:00.000Z')
    writeStoredTheme(storage, 'light', '2026-09-21T01:00:00.000Z')
    writeStoredViewTab(storage, 'database', 'Redis', '2026-09-21T02:00:00.000Z')

    expect(readStoredTheme(storage)).toBe('light')
    expect(readStoredViewTab(storage, 'logs')).toBe('login')
    expect(readStoredViewTab(storage, 'database')).toBe('Redis')
  })

  it('跟随系统只清主题，已存页签仍在；页签也没有时才整份删掉', () => {
    const storage = fakeStorage()
    writeStoredTheme(storage, 'light', '2026-09-15T00:00:00.000Z')
    writeStoredViewTab(storage, 'containers', 'images', '2026-09-21T00:00:00.000Z')
    clearStoredTheme(storage)

    expect(readStoredTheme(storage)).toBeNull()
    expect(readStoredViewTab(storage, 'containers')).toBe('images')

    const empty = fakeStorage()
    writeStoredTheme(empty, 'dark', '2026-09-15T00:00:00.000Z')
    clearStoredTheme(empty)
    expect(empty.map.has(UI_PREFERENCES_KEY)).toBe(false)
  })

  it('没有存过、版本不认识或取值不是字符串时读页签得到 null', () => {
    expect(readStoredViewTab(fakeStorage(), 'security')).toBeNull()
    expect(
      readStoredViewTab(
        fakeStorage({ [UI_PREFERENCES_KEY]: '{"version":2,"tabs":{"security":"ssh"}}' }),
        'security',
      ),
    ).toBeNull()
    expect(
      readStoredViewTab(
        fakeStorage({ [UI_PREFERENCES_KEY]: '{"version":1,"tabs":{"security":1}}' }),
        'security',
      ),
    ).toBeNull()
  })

  it('导航顺序与主题、页签共存；改其中一项不会丢掉其余', () => {
    const storage = fakeStorage()
    writeStoredTheme(storage, 'dark', '2026-09-15T00:00:00.000Z')
    writeStoredViewTab(storage, 'security', 'ssh', '2026-09-21T00:00:00.000Z')
    writeStoredNavOrder(storage, ['/files', '/security', '/'], '2026-09-21T03:00:00.000Z')

    expect(readStoredTheme(storage)).toBe('dark')
    expect(readStoredViewTab(storage, 'security')).toBe('ssh')
    expect(readStoredNavOrder(storage)).toEqual(['/files', '/security', '/'])

    writeStoredTheme(storage, 'light', '2026-09-21T04:00:00.000Z')
    expect(readStoredNavOrder(storage)).toEqual(['/files', '/security', '/'])
    expect(readStoredViewTab(storage, 'security')).toBe('ssh')
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

  it('resolveViewTab 只接受允许清单里的取值，否则回落默认', () => {
    const storage = fakeStorage()
    writeStoredViewTab(storage, 'security', 'ssh', '2026-09-21T00:00:00.000Z')
    expect(resolveViewTab(storage, 'security', ['firewall', 'ssh', 'users'] as const, 'firewall')).toBe(
      'ssh',
    )

    writeStoredViewTab(storage, 'security', 'unknown', '2026-09-21T00:00:00.000Z')
    expect(resolveViewTab(storage, 'security', ['firewall', 'ssh', 'users'] as const, 'firewall')).toBe(
      'firewall',
    )
    expect(resolveViewTab(fakeStorage(), 'security', ['firewall', 'ssh', 'users'] as const, 'firewall')).toBe(
      'firewall',
    )
  })
})
