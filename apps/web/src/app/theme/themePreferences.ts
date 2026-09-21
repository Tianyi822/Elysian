import type { Theme } from './ThemeProvider'

/**
 * 界面偏好的本地存储格式：主题与顶栏分组页签选中态。
 *
 * 存的是带版本号的结构化数据而不是裸字符串：格式以后要加字段时，读的一侧按 version
 * 判断即可，不必把旧数据当成脏数据丢掉。读的时候逐项校验，认不出来一律返回 null，
 * 由调用方回落到默认值——坏掉的偏好不该让界面打不开。
 *
 * 各字段彼此独立：清掉主题（跟随系统）不得丢掉页签，改页签也不得丢掉主题。
 */
export const VIEW_TAB_KEYS = ['security', 'logs', 'database', 'containers'] as const

export type ViewTabKey = (typeof VIEW_TAB_KEYS)[number]

export type UiPreferences = {
  version: 1
  theme?: Theme
  savedAt: string
  tabs?: Partial<Record<ViewTabKey, string>>
}

export const UI_PREFERENCES_KEY = 'elysian.ui-preferences'

/** 只用到三个方法，测试因此可以传一个内存对象进来。 */
export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function isViewTabKey(value: string): value is ViewTabKey {
  return (VIEW_TAB_KEYS as readonly string[]).includes(value)
}

function parseTabs(value: unknown): Partial<Record<ViewTabKey, string>> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const tabs: Partial<Record<ViewTabKey, string>> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isViewTabKey(key) && typeof entry === 'string') tabs[key] = entry
  }
  return Object.keys(tabs).length > 0 ? tabs : undefined
}

function parsePreferences(storage: PreferenceStorage): UiPreferences | null {
  const raw = storage.getItem(UI_PREFERENCES_KEY)
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const record = parsed as Record<string, unknown>
  if (record.version !== 1) return null

  const theme = record.theme === 'light' || record.theme === 'dark' ? record.theme : undefined
  const savedAt = typeof record.savedAt === 'string' ? record.savedAt : ''
  const tabs = parseTabs(record.tabs)

  return {
    version: 1,
    ...(theme ? { theme } : {}),
    savedAt,
    ...(tabs ? { tabs } : {}),
  }
}

function writePreferences(storage: PreferenceStorage, value: UiPreferences): void {
  storage.setItem(UI_PREFERENCES_KEY, JSON.stringify(value))
}

export function readStoredTheme(storage: PreferenceStorage): Theme | null {
  return parsePreferences(storage)?.theme ?? null
}

export function writeStoredTheme(
  storage: PreferenceStorage,
  theme: Theme,
  savedAt = new Date().toISOString(),
): void {
  const current = parsePreferences(storage)
  writePreferences(storage, {
    version: 1,
    theme,
    savedAt,
    ...(current?.tabs ? { tabs: current.tabs } : {}),
  })
}

export function clearStoredTheme(storage: PreferenceStorage): void {
  const current = parsePreferences(storage)
  if (!current?.tabs) {
    storage.removeItem(UI_PREFERENCES_KEY)
    return
  }
  writePreferences(storage, {
    version: 1,
    savedAt: current.savedAt,
    tabs: current.tabs,
  })
}

export function readStoredViewTab(storage: PreferenceStorage, key: ViewTabKey): string | null {
  const value = parsePreferences(storage)?.tabs?.[key]
  return typeof value === 'string' ? value : null
}

export function writeStoredViewTab(
  storage: PreferenceStorage,
  key: ViewTabKey,
  value: string,
  savedAt = new Date().toISOString(),
): void {
  const current = parsePreferences(storage)
  writePreferences(storage, {
    version: 1,
    ...(current?.theme ? { theme: current.theme } : {}),
    savedAt,
    tabs: { ...current?.tabs, [key]: value },
  })
}

/** 已存取值必须落在允许清单里，否则回落默认——旧偏好或手改的脏数据不能卡住界面。 */
export function resolveViewTab<T extends string>(
  storage: PreferenceStorage,
  key: ViewTabKey,
  allowed: readonly T[],
  fallback: T,
): T {
  const stored = readStoredViewTab(storage, key)
  return stored !== null && (allowed as readonly string[]).includes(stored)
    ? (stored as T)
    : fallback
}
