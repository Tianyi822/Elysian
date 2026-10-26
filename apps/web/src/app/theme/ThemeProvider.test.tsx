import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UI_PREFERENCES_KEY, browserPreferenceStorage } from './themePreferences'
import { ThemeProvider, useTheme } from './ThemeProvider'
import { useNotificationStore } from '../../stores/notificationStore'

/** 只暴露当前主题与切换动作；DOM 上的属性由用例直接读，避免在渲染期读到上一次提交的值。 */
function ThemeProbe() {
  const { theme, followsSystem, toggleTheme, followSystemTheme } = useTheme()
  return (
    <div>
      <p data-testid="主题状态">{theme}</p>
      <p data-testid="跟随系统">{String(followsSystem)}</p>
      <button type="button" onClick={toggleTheme}>
        切换主题
      </button>
      <button type="button" onClick={followSystemTheme}>
        跟随系统主题
      </button>
    </div>
  )
}

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

const storedLight = { [UI_PREFERENCES_KEY]: '{"version":1,"theme":"light","savedAt":"x"}' }

afterEach(() => {
  delete document.documentElement.dataset['theme']
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('主题初值', () => {
  it('浏览器拒绝访问 localStorage 时仍可打开页面并切换主题', async () => {
    const user = userEvent.setup()
    const blocked = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    try {
      document.documentElement.dataset['theme'] = 'dark'
      render(<ThemeProvider><ThemeProbe /></ThemeProvider>)
      expect(screen.getByTestId('主题状态')).toHaveTextContent('dark')
      await user.click(screen.getByRole('button', { name: '切换主题' }))
      expect(screen.getByTestId('主题状态')).toHaveTextContent('light')
      expect(useNotificationStore.getState().notifications.at(-1)).toMatchObject({ tone: 'warning', message: expect.stringContaining('无法保存界面偏好') })
    } finally { blocked.mockRestore(); browserPreferenceStorage.removeItem(UI_PREFERENCES_KEY) }
  })

  it('缺少媒体查询时跟随系统可回落深色，不影响操作', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('matchMedia', undefined)
    render(<ThemeProvider preferenceStorage={fakeStorage(storedLight)}><ThemeProbe /></ThemeProvider>)
    await user.click(screen.getByRole('button', { name: '跟随系统主题' }))
    expect(screen.getByTestId('主题状态')).toHaveTextContent('dark')
  })

  it('继承启动脚本写在 html 上的浅色，不回到深色', () => {
    document.documentElement.dataset['theme'] = 'light'
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    )

    expect(screen.getByTestId('主题状态')).toHaveTextContent('light')
    expect(document.documentElement.dataset['theme']).toBe('light')
  })

  it('html 上没有主题属性时回落深色，并把回落值写回 DOM', () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    )

    expect(screen.getByTestId('主题状态')).toHaveTextContent('dark')
    expect(document.documentElement.dataset['theme']).toBe('dark')
  })

  it('切换后状态与 DOM 属性一起改变，手动选择优先于初值', async () => {
    const user = userEvent.setup()
    document.documentElement.dataset['theme'] = 'light'
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    )

    await user.click(screen.getByRole('button', { name: '切换主题' }))

    expect(screen.getByTestId('主题状态')).toHaveTextContent('dark')
    expect(document.documentElement.dataset['theme']).toBe('dark')
  })
})

describe('主题偏好持久化', () => {
  it('只提供旧式监听时仍跟随系统变化，卸载后移除监听', () => {
    const addListener = vi.fn(), removeListener = vi.fn()
    const media = { matches: false, addListener, removeListener }
    vi.stubGlobal('matchMedia', () => media)
    const view = render(<ThemeProvider preferenceStorage={fakeStorage()}><ThemeProbe /></ThemeProvider>)
    media.matches = true
    act(() => addListener.mock.calls[0]![0]())
    expect(screen.getByTestId('主题状态')).toHaveTextContent('light')
    view.unmount()
    expect(removeListener).toHaveBeenCalledWith(addListener.mock.calls[0]![0])
  })
  it('存过偏好时初值取偏好，优先于 html 上的启动属性', () => {
    document.documentElement.dataset['theme'] = 'dark'
    render(
      <ThemeProvider preferenceStorage={fakeStorage(storedLight)}>
        <ThemeProbe />
      </ThemeProvider>,
    )

    expect(screen.getByTestId('主题状态')).toHaveTextContent('light')
    expect(screen.getByTestId('跟随系统')).toHaveTextContent('false')
  })

  it('切换把选择写进偏好存储，并标记不再跟随系统', async () => {
    const user = userEvent.setup()
    const storage = fakeStorage()
    render(
      <ThemeProvider preferenceStorage={storage}>
        <ThemeProbe />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('跟随系统')).toHaveTextContent('true')

    await user.click(screen.getByRole('button', { name: '切换主题' }))

    expect(screen.getByTestId('主题状态')).toHaveTextContent('light')
    expect(JSON.parse(storage.map.get(UI_PREFERENCES_KEY) ?? '{}')).toMatchObject({
      version: 1,
      theme: 'light',
    })
    expect(screen.getByTestId('跟随系统')).toHaveTextContent('false')
  })

  it('跟随系统主题：清掉偏好，回到系统当前偏好对应的档', async () => {
    const user = userEvent.setup()
    const storage = fakeStorage(storedLight)
    render(
      <ThemeProvider preferenceStorage={storage}>
        <ThemeProbe />
      </ThemeProvider>,
    )

    // 系统档由测试显式置为深色，不依赖宿主环境（jsdom 默认报浅色）。
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }))
    await user.click(screen.getByRole('button', { name: '跟随系统主题' }))

    expect(storage.map.has(UI_PREFERENCES_KEY)).toBe(false)
    expect(screen.getByTestId('主题状态')).toHaveTextContent('dark')
    expect(screen.getByTestId('跟随系统')).toHaveTextContent('true')
    expect(document.documentElement.dataset['theme']).toBe('dark')
  })
})
