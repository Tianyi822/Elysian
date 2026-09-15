import { createContext, useCallback, useContext, useInsertionEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  clearStoredTheme,
  readStoredTheme,
  writeStoredTheme,
} from './themePreferences'
import type { PreferenceStorage } from './themePreferences'

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
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/**
 * 主题只改 html[data-theme]，所有颜色差异由语义令牌层承担，
 * 组件里因此不需要写 dark: 变体。
 *
 * 手动选择写进界面偏好存储，下次打开由启动脚本先读它、读不到才问系统；
 * 「跟随系统」清掉这份偏好，把决定权交回系统。
 *
 * 用 insertion effect 翻转属性是有意的：它先于全部被动 effect 执行，
 * 依赖主题的子组件（例如图表读取配色）在自己的 effect 里读到的已经是新主题。
 */
export function ThemeProvider({
  children,
  preferenceStorage = window.localStorage,
}: {
  children: ReactNode
  preferenceStorage?: PreferenceStorage
}) {
  const [theme, setThemeState] = useState<Theme>(
    () => readStoredTheme(preferenceStorage) ?? readBootTheme(),
  )
  const [followsSystem, setFollowsSystem] = useState(
    () => readStoredTheme(preferenceStorage) === null,
  )

  useInsertionEffect(() => {
    document.documentElement.dataset['theme'] = theme
  }, [theme])

  const setTheme = useCallback(
    (next: Theme) => {
      writeStoredTheme(preferenceStorage, next)
      setFollowsSystem(false)
      setThemeState(next)
    },
    [preferenceStorage],
  )

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }, [setTheme, theme])

  const followSystemTheme = useCallback(() => {
    clearStoredTheme(preferenceStorage)
    setFollowsSystem(true)
    setThemeState(readSystemTheme())
  }, [preferenceStorage])

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
