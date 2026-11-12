import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useImeEnterGuard } from './useImeEnterGuard'

function FormHarness({ onSubmit }: { onSubmit(): void }) {
  const { guardProps, isImeKey } = useImeEnterGuard()
  return <form {...guardProps} onSubmit={event => { event.preventDefault(); if (isImeKey()) return; onSubmit() }}>
    <label htmlFor="ime-form-field">名称</label>
    <input id="ime-form-field" />
    <button type="submit">保存</button>
  </form>
}

function KeyHarness({ onEnter }: { onEnter(): void }) {
  const { guardProps, isImeKey } = useImeEnterGuard()
  return <input aria-label="名称" {...guardProps} onKeyDown={event => {
    if (event.key === 'Enter' && !isImeKey(event)) { event.preventDefault(); onEnter() }
  }} />
}

function ProbeHarness({ report }: { report(ime: boolean): void }) {
  const { guardProps, isImeKey } = useImeEnterGuard()
  return <input aria-label="名称" {...guardProps} onKeyDown={event => report(isImeKey(event))} />
}

describe('useImeEnterGuard', () => {
  it('组合中的回车被拦下，隐式提交与显式提交都不发生', () => {
    const onSubmit = vi.fn()
    render(<FormHarness onSubmit={onSubmit} />)
    const field = screen.getByLabelText('名称')
    fireEvent.compositionStart(field)
    expect(fireEvent.keyDown(field, { key: 'Enter', isComposing: true, keyCode: 229 })).toBe(false)
    fireEvent.submit(field.closest('form')!)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('确认回车派发于 compositionend 之后时仍被吞掉一次', () => {
    const onSubmit = vi.fn()
    render(<FormHarness onSubmit={onSubmit} />)
    const field = screen.getByLabelText('名称')
    fireEvent.compositionStart(field)
    fireEvent.compositionEnd(field)
    expect(fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 })).toBe(false)
    fireEvent.submit(field.closest('form')!)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('吞掉的只有那一枚：随后的人工回车正常提交', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<FormHarness onSubmit={onSubmit} />)
    const field = screen.getByLabelText('名称')
    fireEvent.compositionStart(field)
    fireEvent.compositionEnd(field)
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 })
    await user.click(field)
    await user.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('鼠标选词结束组合后，人工回车不被误吞', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<FormHarness onSubmit={onSubmit} />)
    const field = screen.getByLabelText('名称')
    fireEvent.compositionStart(field)
    fireEvent.compositionEnd(field)
    await user.click(field)
    await user.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('没有组合时的人工回车直接提交', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<FormHarness onSubmit={onSubmit} />)
    await user.type(screen.getByLabelText('名称'), 'admin{Enter}')
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('独立输入控件共用同一判定：组合中与组合刚结束的回车都不触发动作', async () => {
    const user = userEvent.setup()
    const onEnter = vi.fn()
    render(<KeyHarness onEnter={onEnter} />)
    const field = screen.getByLabelText('名称')
    fireEvent.compositionStart(field)
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true, keyCode: 229 })
    fireEvent.compositionEnd(field)
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 })
    expect(onEnter).not.toHaveBeenCalled()
    await user.click(field)
    await user.keyboard('{Enter}')
    expect(onEnter).toHaveBeenCalledOnce()
  })

  it('组合中的方向键属于输入法，组合结束后交回列表', () => {
    const report = vi.fn()
    render(<ProbeHarness report={report} />)
    const field = screen.getByLabelText('名称')
    fireEvent.compositionStart(field)
    fireEvent.keyDown(field, { key: 'ArrowDown', isComposing: true, keyCode: 229 })
    expect(report).toHaveBeenLastCalledWith(true)
    fireEvent.compositionEnd(field)
    fireEvent.keyDown(field, { key: 'ArrowDown', keyCode: 40 })
    expect(report).toHaveBeenLastCalledWith(false)
  })
})