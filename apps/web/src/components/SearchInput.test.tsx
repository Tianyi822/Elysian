import { createRef, type KeyboardEvent } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SearchInput } from './SearchInput'

describe('共享搜索框', () => {
  it('值由页面受控，清空交回页面并将焦点归还真实输入元素', async () => {
    const user = userEvent.setup()
    const change = vi.fn()
    const clear = vi.fn()
    const ref = createRef<HTMLInputElement>()
    const view = (value: string) => <Tooltip.Provider><SearchInput ref={ref} label="搜索项目"
      value={value} onChange={change} onClear={clear} /></Tooltip.Provider>
    const { rerender } = render(view('alpha'))
    const input = screen.getByRole('searchbox', { name: '搜索项目' })
    expect(ref.current).toBe(input)
    await user.click(screen.getByRole('button', { name: '清空搜索' }))
    expect(change).toHaveBeenLastCalledWith('')
    expect(clear).toHaveBeenCalledTimes(1)
    expect(input).toHaveValue('alpha')
    expect(input).toHaveFocus()
    rerender(view(''))
    expect(input).toHaveValue('')
    await waitFor(() => expect(screen.queryByRole('button', { name: '清空搜索' })).not.toBeInTheDocument())
  })

  it('保留调用方的按键处理，输入法确认及紧随组合结束的回车不提交', async () => {
    const submit = vi.fn()
    const customKey = vi.fn((event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') event.preventDefault()
    })
    render(<Tooltip.Provider><SearchInput label="搜索版本" value="版本" onChange={() => {}}
      onSubmit={submit} inputProps={{ onKeyDown: customKey }} /></Tooltip.Provider>)
    const input = screen.getByRole('searchbox', { name: '搜索版本' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(customKey).toHaveBeenCalledTimes(1)
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(submit).not.toHaveBeenCalled()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(submit).toHaveBeenCalledExactlyOnceWith('版本')
  })
})
