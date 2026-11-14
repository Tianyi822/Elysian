import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { HeaderTabs } from './HeaderTabs'

const TABS = [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }] as const
function Controlled() {
  const [value, setValue] = useState<'a' | 'b'>('a')
  return <HeaderTabs items={TABS} value={value} onSelect={setValue} groupLabel="测试页签" />
}

describe('HeaderTabs 的 EasyUI 受控适配', () => {
  it('恢复受控选中值并保留分组和按钮语义', () => {
    render(<HeaderTabs items={TABS} value="b" onSelect={() => {}} groupLabel="测试页签" />)
    const group = screen.getByRole('group', { name: '测试页签' })
    expect(group).toHaveAttribute('data-easyui', 'pill-navigation')
    expect(within(group).getByRole('button', { name: '甲' })).toHaveAttribute('aria-pressed', 'false')
    expect(within(group).getByRole('button', { name: '乙' })).toHaveAttribute('aria-pressed', 'true')
    expect(group.querySelectorAll('[data-easyui-indicator]')).toHaveLength(1)
  })

  it('点击切换仍由调用方持有状态，只有选中按钮包含选中块', async () => {
    const user = userEvent.setup()
    render(<Controlled />)
    await user.click(screen.getByRole('button', { name: '乙' }))
    const selected = screen.getByRole('button', { name: '乙' })
    expect(selected).toHaveAttribute('aria-pressed', 'true')
    expect(selected.querySelector('[data-easyui-indicator]')).not.toBeNull()
    expect(screen.getByRole('button', { name: '甲' }).querySelector('[data-easyui-indicator]')).toBeNull()
  })

  it('键盘原生激活切换页签，不触发表单提交', async () => {
    const user = userEvent.setup()
    render(<Controlled />)
    screen.getByRole('button', { name: '乙' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: '乙' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '乙' })).toHaveAttribute('type', 'button')
  })

  it('未知选中值不在其他项上残留选中块', () => {
    render(<HeaderTabs items={TABS} value={'c' as 'a'} onSelect={() => {}} groupLabel="测试页签" />)
    expect(screen.getByRole('group', { name: '测试页签' }).querySelector('[data-easyui-indicator]')).toBeNull()
  })
})
