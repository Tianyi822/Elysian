import * as Tooltip from '@radix-ui/react-tooltip'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RefreshButton } from './RefreshState'

describe('共享刷新按钮', () => {
  it('沿用受控忙碌与禁用，完成后可继续用键盘刷新', async () => {
    const user = userEvent.setup()
    const refresh = vi.fn()
    const view = (busy: boolean) => <Tooltip.Provider><RefreshButton label="刷新列表"
      onPress={refresh} busy={busy} /></Tooltip.Provider>
    const { rerender } = render(view(false))
    const button = screen.getByRole('button', { name: '刷新列表' })
    await user.click(button)
    expect(refresh).toHaveBeenCalledTimes(1)
    rerender(view(true))
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    await user.click(button)
    expect(refresh).toHaveBeenCalledTimes(1)
    rerender(view(false))
    expect(button).toBeEnabled()
    button.focus()
    await user.keyboard('{Enter}')
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
