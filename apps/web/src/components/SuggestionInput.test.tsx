import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tooltip from '@radix-ui/react-tooltip'
import { SuggestionInput } from './SuggestionInput'

const ITEMS = [{ value: 'deepseek-flash', label: 'deepseek-flash' }, { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro' }]
function Field({ disabled = false, onSubmit = () => {} }: { disabled?: boolean; onSubmit?(): void }) {
  const [value, setValue] = useState('')
  return <Tooltip.Provider><form onSubmit={event => { event.preventDefault(); onSubmit() }}>
    <label htmlFor="suggestion-model">模型标识</label>
    <SuggestionInput id="suggestion-model" ariaLabel="模型标识" value={value} onValueChange={setValue} items={ITEMS} required disabled={disabled} />
    <button type="submit">保存</button>
  </form></Tooltip.Provider>
}

describe('SuggestionInput', () => {
  it('保留原生输入校验和自由输入，候选项不限制自定义值', async () => {
    const user = userEvent.setup()
    const submit = vi.fn()
    render(<Field onSubmit={submit} />)
    const input = screen.getByRole('combobox', { name: '模型标识' })
    expect(input).toBeInvalid()
    await user.type(input, 'my-local-model')
    expect(input).toHaveValue('my-local-model')
    expect(input).toBeValid()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(submit).toHaveBeenCalledOnce()
  })

  it('方向键与 Enter 选择候选，不提交表单，Escape 保留输入并关闭', async () => {
    const user = userEvent.setup()
    const submit = vi.fn()
    render(<Field onSubmit={submit} />)
    const input = screen.getByRole('combobox', { name: '模型标识' })
    await user.click(input)
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(input).toHaveValue('deepseek-v4-pro')
    expect(input).toHaveFocus()
    expect(submit).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(input).toHaveFocus()
    expect(input).toHaveValue('deepseek-v4-pro')
  })

  it('候选按钮展示完整集合，鼠标选择后回到输入框，点击外部关闭', async () => {
    const user = userEvent.setup()
    render(<Field />)
    const input = screen.getByRole('combobox', { name: '模型标识' })
    await user.type(input, 'custom')
    await user.click(screen.getByRole('button', { name: '选择模型标识候选项' }))
    expect(screen.getAllByRole('option')).toHaveLength(2)
    await user.click(screen.getByRole('option', { name: 'deepseek-flash' }))
    expect(input).toHaveValue('deepseek-flash')
    expect(input).toHaveFocus()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await user.keyboard('{ArrowDown}')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('禁用字段不打开候选列表', async () => {
    const user = userEvent.setup()
    render(<Field disabled />)
    expect(screen.getByRole('combobox', { name: '模型标识' })).toBeDisabled()
    const trigger = screen.getByRole('button', { name: '选择模型标识候选项' })
    expect(trigger).toBeDisabled()
    await user.click(trigger)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('候选 Portal 在弹窗中可选择，列表自行消费滚轮，Escape 只关闭列表', async () => {
    const user = userEvent.setup()
    render(<Dialog.Root open><Dialog.Portal><Dialog.Content aria-describedby={undefined}>
      <Dialog.Title>编辑模型</Dialog.Title><Field />
    </Dialog.Content></Dialog.Portal></Dialog.Root>)
    const input = screen.getByRole('combobox', { name: '模型标识' })
    await user.click(input)
    const list = screen.getByRole('listbox')
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 800 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 })
    list.scrollTop = 40
    const outsideWheel = vi.fn()
    document.addEventListener('wheel', outsideWheel)
    fireEvent.wheel(list, { deltaY: 30 })
    document.removeEventListener('wheel', outsideWheel)
    expect(outsideWheel).not.toHaveBeenCalled()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(input).toHaveValue('deepseek-flash')
    await user.keyboard('{ArrowDown}{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
