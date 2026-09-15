import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ThemeProvider, useTheme } from './ThemeProvider'

/** 只暴露当前主题与切换动作；DOM 上的属性由用例直接读，避免在渲染期读到上一次提交的值。 */
function ThemeProbe() {
  const { theme, toggleTheme } = useTheme()
  return (
    <div>
      <p data-testid="主题状态">{theme}</p>
      <button type="button" onClick={toggleTheme}>
        切换主题
      </button>
    </div>
  )
}

afterEach(() => {
  delete document.documentElement.dataset['theme']
})

describe('主题初值', () => {
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
