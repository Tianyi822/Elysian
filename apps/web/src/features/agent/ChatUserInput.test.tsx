import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AgentUserInputAnswer } from '@elysian/contracts'
import { chatTestUserInput } from '../../test/agentChatFixtures'
import { ChatUserInput, ChatUserInputSummary } from './ChatUserInput'

function Interactive({ submit = vi.fn(), cancel = vi.fn() }) {
  const [answers, setAnswers] = useState<Record<string, AgentUserInputAnswer>>({})
  return <ChatUserInput request={chatTestUserInput} answers={answers} submitting={false} pending={false}
    onAnswer={(id, answer) => setAnswers(old => ({ ...old, [id]: answer }))} onSubmit={() => submit(answers)} onCancel={cancel} />
}

describe('用户选择卡片', () => {
  it('推荐项不自动选中，多题返回保留答案，完整回答后统一提交', async () => {
    const user = userEvent.setup(); const submit = vi.fn()
    render(<Interactive submit={submit} />)
    expect(screen.getAllByRole('radio').every(radio => radio.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
    await user.click(screen.getByRole('radio', { name: /面板自身/ }))
    expect(screen.getByText('第 2/2 题')).toBeInTheDocument()
    expect(screen.getByText('查看哪个时间？')).toHaveFocus()
    expect(screen.getByRole('button', { name: '提交选择' })).toBeDisabled()
    await user.click(screen.getByRole('radio', { name: /自定义回答/ }))
    await user.type(screen.getByRole('textbox', { name: '自定义回答' }), '最近一次采样')
    fireEvent.compositionStart(screen.getByRole('textbox'))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true })
    expect(submit).not.toHaveBeenCalled()
    fireEvent.compositionEnd(screen.getByRole('textbox'))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(submit).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '上一步' }))
    expect(screen.getByRole('radio', { name: /面板自身/ })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByRole('textbox')).toHaveValue('最近一次采样')
    await user.click(screen.getByRole('button', { name: '提交选择' }))
    expect(submit).toHaveBeenCalledExactlyOnceWith({ scope: { optionId: 'panel' }, period: { text: '最近一次采样' } })
  })
  it.each(['{Enter}', ' '])('方向键只浏览，%s 确认后进入下一题，最后一题手动提交', async activation => {
    const user = userEvent.setup(); const submit = vi.fn()
    render(<Interactive submit={submit} />)
    screen.getAllByRole('radio')[0]!.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('radio', { name: /系统整体/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('第 1/2 题')).toBeInTheDocument()
    await user.keyboard('{Home}')
    expect(screen.getByRole('radio', { name: /面板自身/ })).toHaveAttribute('aria-checked', 'true')
    await user.keyboard(activation)
    expect(screen.getByText('第 2/2 题')).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: /现在/ }))
    expect(screen.getByRole('radio', { name: /现在/ })).toHaveAttribute('aria-checked', 'true')
    await user.keyboard('{Enter}')
    expect(submit).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '提交选择' }))
    expect(submit).toHaveBeenCalledExactlyOnceWith({ scope: { optionId: 'panel' }, period: { optionId: 'now' } })
  })
  it('自定义回答停留输入，输入法不翻题，确认后前进且可取消本轮', async () => {
    const user = userEvent.setup(); const cancel = vi.fn()
    render(<Interactive cancel={cancel} />)
    await user.click(screen.getByRole('radio', { name: /自定义回答/ }))
    const textbox = screen.getByRole('textbox')
    expect(textbox).toHaveFocus()
    await user.type(textbox, '只查看面板')
    expect(screen.getByText('第 1/2 题')).toBeInTheDocument()
    fireEvent.compositionStart(textbox)
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true })
    expect(screen.getByText('第 1/2 题')).toBeInTheDocument()
    fireEvent.compositionEnd(textbox)
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(screen.getByText('第 2/2 题')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消本轮' }))
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('自定义回答：组合中与组合刚结束的 Ctrl/⌘+Enter 都不推进也不提交，随后的人工确认才生效', async () => {
    const user = userEvent.setup(); const submit = vi.fn()
    render(<Interactive submit={submit} />)
    await user.click(screen.getByRole('radio', { name: /自定义回答/ }))
    const textbox = screen.getByRole('textbox', { name: '自定义回答' })
    await user.type(textbox, '只查看面板')
    // 组合中：这枚 Ctrl+Enter 属于输入法，不翻题。
    fireEvent.compositionStart(textbox)
    fireEvent.change(textbox, { target: { value: '只查看面板自身' } })
    expect(fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true, isComposing: true, keyCode: 229 })).toBe(false)
    expect(screen.getByText('第 1/2 题')).toBeInTheDocument()
    // 组合刚结束：确认回车派发在 compositionend 之后，Ctrl 与 ⌘ 两路都吞掉。
    fireEvent.compositionEnd(textbox)
    expect(fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true, keyCode: 13 })).toBe(false)
    expect(fireEvent.keyDown(textbox, { key: 'Enter', metaKey: true, keyCode: 13 })).toBe(false)
    expect(screen.getByText('第 1/2 题')).toBeInTheDocument()
    expect(submit).not.toHaveBeenCalled()
    // 守卫只吞那一枚：复位后人工 Ctrl+Enter 前进到最后一题。
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(screen.getByText('第 2/2 题')).toBeInTheDocument()
    expect(submit).not.toHaveBeenCalled()

    await user.click(screen.getByRole('radio', { name: /自定义回答/ }))
    const last = screen.getByRole('textbox', { name: '自定义回答' })
    await user.type(last, '最近一次采样')
    fireEvent.compositionStart(last)
    fireEvent.keyDown(last, { key: 'Enter', metaKey: true, isComposing: true, keyCode: 229 })
    fireEvent.compositionEnd(last)
    expect(fireEvent.keyDown(last, { key: 'Enter', metaKey: true, keyCode: 13 })).toBe(false)
    expect(submit).not.toHaveBeenCalled()
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(submit).toHaveBeenCalledExactlyOnceWith({ scope: { text: '只查看面板自身' }, period: { text: '最近一次采样' } })
  })
  it('结果未知时锁定原回答，重试不修改选择，历史只读展示', async () => {
    const submit = vi.fn(); const answer = vi.fn()
    const answers = { scope: { optionId: 'panel' }, period: { text: '现在' } }
    const view = render(<ChatUserInput request={chatTestUserInput} answers={answers} submitting={false} pending onAnswer={answer} onSubmit={submit} onCancel={vi.fn()} />)
    expect(screen.getAllByRole('radio').every(radio => radio.hasAttribute('disabled'))).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: '重试提交' }))
    expect(submit).toHaveBeenCalledOnce(); expect(answer).not.toHaveBeenCalled()
    view.rerender(<ChatUserInputSummary request={{ ...chatTestUserInput, status: 'answered', answers }} />)
    expect(screen.getByText(/已提交选择/)).toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    view.rerender(<ChatUserInputSummary request={{ ...chatTestUserInput, status: 'cancelled' }} />)
    expect(screen.getByText(/问题已取消/)).toBeInTheDocument()
  })
})
