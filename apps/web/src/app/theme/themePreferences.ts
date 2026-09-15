import type { Theme } from './ThemeProvider'

/**
 * 界面偏好（目前只有主题）的本地存储格式。
 *
 * 存的是带版本号的结构化数据而不是裸字符串：格式以后要加字段时，读的一侧按 version
 * 判断即可，不必把旧数据当成脏数据丢掉。读的时候逐项校验，认不出来一律返回 null，
 * 由调用方回落到系统偏好——坏掉的偏好不该让界面打不开。
 */
export type UiPreferences = { version: 1; theme: Theme; savedAt: string }

export const UI_PREFERENCES_KEY = 'elysian.ui-preferences'

/** 只用到三个方法，测试因此可以传一个内存对象进来。 */
export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function readStoredTheme(storage: PreferenceStorage): Theme | null {
  const raw = storage.getItem(UI_PREFERENCES_KEY)
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const record = parsed as Partial<UiPreferences>
  if (record.version !== 1) return null
  return record.theme === 'light' || record.theme === 'dark' ? record.theme : null
}

export function writeStoredTheme(
  storage: PreferenceStorage,
  theme: Theme,
  savedAt = new Date().toISOString(),
): void {
  const value: UiPreferences = { version: 1, theme, savedAt }
  storage.setItem(UI_PREFERENCES_KEY, JSON.stringify(value))
}

export function clearStoredTheme(storage: PreferenceStorage): void {
  storage.removeItem(UI_PREFERENCES_KEY)
}
