import type { Theme } from './ThemeProvider'

/**
 * 界面偏好的本地存储格式：主题、顶栏分组页签选中态与主导航顺序。
 *
 * 存的是带版本号的结构化数据而不是裸字符串：格式以后要加字段时，读的一侧按 version
 * 判断即可，不必把旧数据当成脏数据丢掉。读的时候逐项校验，认不出来一律返回 null，
 * 由调用方回落到默认值——坏掉的偏好不该让界面打不开。
 *
 * 各字段彼此独立：清掉主题（跟随系统）不得丢掉页签或导航顺序，改其中一项也不得丢掉其余。
 */
export const VIEW_TAB_KEYS = ['security', 'logs', 'database', 'containers'] as const

export type ViewTabKey = (typeof VIEW_TAB_KEYS)[number]

export type UiPreferences = {
  version: 1
  theme?: Theme
  savedAt: string
  tabs?: Partial<Record<ViewTabKey, string>>
  /** 主导航路径顺序。不认识的路径在读取侧合并时丢掉，缺的项按默认顺序补上，仪表盘固定在第一位。 */
  nav?: string[]
}

export const UI_PREFERENCES_KEY = 'elysian.ui-preferences'

/** 只用到三个方法，测试因此可以传一个内存对象进来。 */
export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function isViewTabKey(value: string): value is ViewTabKey {
  return (VIEW_TAB_KEYS as readonly string[]).includes(value)
}

function parseNav(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const paths = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  return paths.length > 0 ? paths : undefined
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
  const nav = parseNav(record.nav)

  return {
    version: 1,
    ...(theme ? { theme } : {}),
    savedAt,
    ...(tabs ? { tabs } : {}),
    ...(nav ? { nav } : {}),
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
    ...(current?.nav ? { nav: current.nav } : {}),
  })
}

export function clearStoredTheme(storage: PreferenceStorage): void {
  const current = parsePreferences(storage)
  if (!current?.tabs && !current?.nav) {
    storage.removeItem(UI_PREFERENCES_KEY)
    return
  }
  writePreferences(storage, {
    version: 1,
    savedAt: current.savedAt,
    ...(current.tabs ? { tabs: current.tabs } : {}),
    ...(current.nav ? { nav: current.nav } : {}),
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
    ...(current?.nav ? { nav: current.nav } : {}),
  })
}

export function readStoredNavOrder(storage: PreferenceStorage): string[] | null {
  return parsePreferences(storage)?.nav ?? null
}

export function writeStoredNavOrder(
  storage: PreferenceStorage,
  order: readonly string[],
  savedAt = new Date().toISOString(),
): void {
  const current = parsePreferences(storage)
  const nav = order.filter((entry) => entry.length > 0)
  if (nav.length === 0 && !current?.theme && !current?.tabs) {
    storage.removeItem(UI_PREFERENCES_KEY)
    return
  }
  writePreferences(storage, {
    version: 1,
    ...(current?.theme ? { theme: current.theme } : {}),
    savedAt,
    ...(current?.tabs ? { tabs: current.tabs } : {}),
    ...(nav.length > 0 ? { nav: [...nav] } : {}),
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
