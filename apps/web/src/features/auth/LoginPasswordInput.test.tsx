import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { LoginPasswordInput } from './LoginPasswordInput'

function Field() {
  const [value, setValue] = useState('')
  return <><label htmlFor="password-test">密码</label><LoginPasswordInput id="password-test" value={value}
    onChange={(event) => setValue(event.target.value)} autoComplete="current-password" /></>
}

describe('登录密码显示层', () => {
  it('文本类型始终不变，显示隐藏保留值和选区，编辑和粘贴仍使用原文', async () => {
    const { container } = render(<Field />)
    const user = userEvent.setup()
    const field = screen.getByLabelText<HTMLInputElement>('密码')
    await user.type(field, 'Abcd!123')
    field.setSelectionRange(1, 4)
    fireEvent.select(field)
    expect(container.querySelectorAll('[data-selected]')).toHaveLength(3)
    expect(field).toHaveAttribute('type', 'text')
    expect(field).toHaveClass('login-password-masked')
    await user.click(screen.getByRole('button', { name: '显示密码' }))
    expect(field).not.toHaveClass('login-password-masked')
    expect(field.selectionStart).toBe(1)
    expect(field.selectionEnd).toBe(4)
    expect(field).toHaveFocus()
    await user.paste('NEW')
    expect(field).toHaveValue('ANEW!123')
    await user.click(screen.getByRole('button', { name: '隐藏密码' }))
    expect(field).toHaveAttribute('type', 'text')
    expect(field).toHaveClass('login-password-masked')
    await user.keyboard('{Backspace}')
    expect(field).toHaveValue('ANE!123')
  })

  it('遮罩按字符簇绘制并随原生滚动同步，隐藏时不向剪贴板复制原文', () => {
    const { container } = render(<Field />)
    const field = screen.getByLabelText<HTMLInputElement>('密码')
    fireEvent.change(field, { target: { value: '中e\u0301👩‍💻' } })
    expect(container.querySelectorAll('.login-password-mask-character')).toHaveLength(3)
    field.scrollLeft = 24
    fireEvent.scroll(field)
    expect(container.querySelector('.login-password-mask-content')).toHaveStyle({ transform: 'translateX(-24px)' })
    expect(fireEvent.copy(field)).toBe(false)
    expect(fireEvent.cut(field)).toBe(false)
    expect(field).toHaveAttribute('spellcheck', 'false')
    expect(field).toHaveAttribute('autocorrect', 'off')
    expect(field).toHaveAttribute('autocapitalize', 'none')
  })
})
