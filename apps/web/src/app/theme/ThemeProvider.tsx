import { createContext, useCallback, useContext, useInsertionEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export type Theme = 'dark' | 'light'

type ThemeContextValue = {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
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

/**
 * 主题只改 html[data-theme]，所有颜色差异由语义令牌层承担，
 * 组件里因此不需要写 dark: 变体。
 *
 * 用 insertion effect 翻转属性是有意的：它先于全部被动 effect 执行，
 * 依赖主题的子组件（例如图表读取配色）在自己的 effect 里读到的已经是新主题。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readBootTheme)

  useInsertionEffect(() => {
    document.documentElement.dataset['theme'] = theme
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, toggleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return value
}
