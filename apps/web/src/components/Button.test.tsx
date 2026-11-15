import { createRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './Button'

describe('共享 PressButton', () => {
  it('保留原生 ref、表单提交和 Enter／Space 单次激活', async () => {
    const user = userEvent.setup()
    const submit = vi.fn()
    const cancel = vi.fn()
    const pointerDown = vi.fn()
    const ref = createRef<HTMLButtonElement>()
    render(<form onSubmit={event => { event.preventDefault(); submit() }}>
      <Button ref={ref} type="submit" name="action" value="save" onPointerDown={pointerDown}>保存</Button>
      <Button onClick={cancel}>取消</Button>
    </form>)
    const save = screen.getByRole('button', { name: '保存' })
    expect(ref.current).toBe(save)
    expect(save).toHaveAttribute('name', 'action')
    expect(save).toHaveAttribute('value', 'save')
    save.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(submit).toHaveBeenCalledTimes(2)
    expect(pointerDown).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('加载期间禁止重复提交，保留稳定名称，完成后恢复操作', async () => {
    const user = userEvent.setup()
    const action = vi.fn()
    const view = (loading: boolean) => <Button aria-label="保存配置" onClick={action}
      isLoading={loading} loadingText="保存中…" leftIcon={<span aria-hidden>+</span>}>保存配置</Button>
    const { rerender } = render(view(false))
    const button = screen.getByRole('button', { name: '保存配置' })
    await user.click(button)
    rerender(view(true))
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveTextContent('保存中…')
    await user.click(button)
    expect(action).toHaveBeenCalledTimes(1)
    rerender(view(false))
    expect(button).toBeEnabled()
    button.focus()
    await user.keyboard('{Enter}')
    expect(action).toHaveBeenCalledTimes(2)
  })

  it('兼容 Radix asChild 的触发、关闭和焦点归还', async () => {
    const user = userEvent.setup()
    render(<Dialog.Root>
      <Dialog.Trigger asChild><Button>添加规则</Button></Dialog.Trigger>
      <Dialog.Portal><Dialog.Content aria-describedby={undefined}>
        <Dialog.Title>规则表单</Dialog.Title>
        <Dialog.Close asChild><Button variant="outline">取消添加</Button></Dialog.Close>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>)
    const trigger = screen.getByRole('button', { name: '添加规则' })
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: '规则表单' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '取消添加' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('dialog')).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('复合控件保留直接子元素、ARIA 状态和键盘处理', async () => {
    const user = userEvent.setup()
    const keydown = vi.fn()
    render(<Button unstyled role="tab" aria-selected="true" tabIndex={0}
      onKeyDown={keydown}><span>容器终端</span></Button>)
    const tab = screen.getByRole('tab', { name: '容器终端', selected: true })
    expect(tab.firstElementChild).toHaveTextContent('容器终端')
    expect(tab.childElementCount).toBe(1)
    tab.focus()
    await user.keyboard('{ArrowRight}')
    expect(keydown).toHaveBeenCalledOnce()
  })
})
