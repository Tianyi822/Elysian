import { createContext, useCallback, useContext, useEffect, useInsertionEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  clearStoredTheme,
  readStoredTheme,
  writeStoredTheme,
  browserPreferenceStorage,
  reportPreferenceStorageFailure,
} from './themePreferences'
import type { PreferenceStorage } from './themePreferences'
import { resilientPreferenceStorage } from '../../utils/preferenceStorage'
import { mediaQuery, observeMediaQuery } from '../../utils/mediaQuery'

export type Theme = 'dark' | 'light'

type ThemeContextValue = {
  theme: Theme
  /** 没有存过偏好时为 true：当前主题来自系统偏好，改系统设置会跟着走。 */
  followsSystem: boolean
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  /** 清掉已存偏好，回到跟随系统。 */
  followSystemTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

/**
 * 首屏主题取 index.html 启动脚本落在 html 上的值：那一步发生在样式生效之前，
 * 界面从这里继承而不是另算一次，两边因此不会给出不同的答案。
 * 属性不存在（测试环境）按深色处理。
 */
function readBootTheme(): Theme {
  return document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark'
}

function readSystemTheme(): Theme {
  return mediaQuery('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark'
}

/**
 * 主题只改 html[data-theme]，所有颜色差异由语义令牌层承担，
 * 组件里因此不需要写 dark: 变体。
 *
 * 手动选择写进界面偏好存储，下次打开由启动脚本先读它、读不到才问系统；
 * 「跟随系统」清掉这份偏好，把决定权交回系统。
 *
 * data-theme 在渲染期同步写入，并在 insertion effect 再确认一次：
 * 子树在 render 或 effect 里读 computed style（如图表配色）都能拿到新主题。
 */
export function ThemeProvider({
  children,
  preferenceStorage,
}: {
  children: ReactNode
  preferenceStorage?: PreferenceStorage
}) {
  const storage = useMemo(() => preferenceStorage
    ? resilientPreferenceStorage(() => preferenceStorage, reportPreferenceStorageFailure)
    : browserPreferenceStorage, [preferenceStorage])
  const [theme, setThemeState] = useState<Theme>(
    () => readStoredTheme(storage) ?? readBootTheme(),
  )
  const [followsSystem, setFollowsSystem] = useState(
    () => readStoredTheme(storage) === null,
  )

  // 渲染期同步翻转，子树若在 render 里读 computed style（如图表配色）也能拿到新主题。
  // insertion effect 再写一次，覆盖并发/严格模式边界。
  if (typeof document !== 'undefined') {
    document.documentElement.dataset['theme'] = theme
  }

  useInsertionEffect(() => {
    document.documentElement.dataset['theme'] = theme
  }, [theme])

  useEffect(() => {
    if (!followsSystem) return
    const media = mediaQuery('(prefers-color-scheme: light)')
    return observeMediaQuery(media, () => setThemeState(media?.matches ? 'light' : 'dark'))
  }, [followsSystem])

  const setTheme = useCallback(
    (next: Theme) => {
      writeStoredTheme(storage, next)
      setFollowsSystem(false)
      setThemeState(next)
    },
    [storage],
  )

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }, [setTheme, theme])

  const followSystemTheme = useCallback(() => {
    clearStoredTheme(storage)
    setFollowsSystem(true)
    setThemeState(readSystemTheme())
  }, [storage])

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, followsSystem, setTheme, toggleTheme, followSystemTheme }),
    [theme, followsSystem, setTheme, toggleTheme, followSystemTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return value
}
