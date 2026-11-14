import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ToggleSwitch } from './ToggleSwitch'

describe('全局液态开关', () => {
  it('等待受控状态确认才显示新状态，忙碌期间拒绝再次切换', async () => {
    const user = userEvent.setup()
    const change = vi.fn()
    const { rerender } = render(<ToggleSwitch label="启用功能" checked={false} onCheckedChange={change} />)
    const control = screen.getByRole('switch', { name: '启用功能' })
    await user.click(control)
    expect(change).toHaveBeenLastCalledWith(true)
    expect(control).toHaveAttribute('aria-checked', 'false')
    rerender(<ToggleSwitch label="启用功能" checked onCheckedChange={change} />)
    expect(control).toHaveAttribute('aria-checked', 'true')
    await user.keyboard('{ArrowLeft}')
    expect(change).toHaveBeenLastCalledWith(false)
    rerender(<ToggleSwitch label="启用功能" checked busy onCheckedChange={change} />)
    change.mockClear()
    expect(control).toBeDisabled()
    expect(control).toHaveAttribute('aria-busy', 'true')
    await user.click(control)
    expect(change).not.toHaveBeenCalled()
  })
})
