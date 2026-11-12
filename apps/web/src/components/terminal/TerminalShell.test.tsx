import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TerminalShell } from './TerminalShell'

function Harness({ onClose = () => {}, interactive = true }: { onClose?: () => void; interactive?: boolean }) {
  return <><div data-testid="outside">外部</div><TerminalShell title="数据库会话" banner="数据库协议会话" subject="db-main" onClose={onClose} interactive={interactive}
    labels={{ close: '关闭会话', confirmTitle: '确认关闭会话？', confirmDescription: '未执行的语句将丢失。', confirmCancel: '继续使用', confirmAccept: '确认关闭' }}>
    <div data-testid="third-party-terminal" tabIndex={0}>第三方终端</div>
  </TerminalShell></>
}

describe('终端弹窗外壳', () => {
  it('渲染传入的终端和领域标注，不再拥有行编辑器', () => {
    render(<Harness />)
    const dialog = screen.getByRole('dialog', { name: '数据库会话' })
    expect(within(dialog).getByText('数据库协议会话')).toBeInTheDocument()
    expect(within(dialog).getByText('db-main')).toBeInTheDocument()
    expect(within(dialog).getByTestId('third-party-terminal')).toBeInTheDocument()
    expect(dialog.querySelector('textarea')).toBeNull()
  })

  it('Esc 与外部点击不关闭会话，只有确认关闭才调用回收', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<Harness onClose={onClose} />)
    await user.keyboard('{Escape}')
    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(onClose).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '关闭会话' }))
    await user.click(screen.getByRole('button', { name: '继续使用' }))
    expect(onClose).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '关闭会话' }))
    await user.click(screen.getByRole('button', { name: '确认关闭' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('连接不可交互时仍可通过键盘关闭', () => {
    render(<Harness interactive={false} />)
    expect(screen.getByRole('button', { name: '关闭会话' })).toHaveFocus()
  })
})
