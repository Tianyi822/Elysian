import { useState } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { GooeySelect } from './GooeySelect'

const items = [
  { value: 'firewall', label: '防火墙' },
  { value: 'disabled', label: '不可用', disabled: true },
  { value: 'ssh', label: 'SSH 管理' },
  { value: 'accounts', label: '主机账号' },
] as const

function Harness({ onSelect = () => {}, active = true, disabled = false }: {
  onSelect?: (value: string) => void; active?: boolean; disabled?: boolean
}) {
  const [value, setValue] = useState<string>('firewall')
  return <Tooltip.Provider><GooeySelect ariaLabel="安全页签" items={items} value={value}
    onSelect={next => { setValue(next); onSelect(next) }} active={active} disabled={disabled} />
    <button type="button">下一个控件</button>
  </Tooltip.Provider>
}

function expectActive(label: string) {
  expect(screen.getByRole('listbox')).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: label }).id)
}

describe('EasyUI 收纳导航 GooeySelect', () => {
  it('整颗胶囊展开选项，回填选中值并归还焦点，支持重复选择', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    await user.click(screen.getByRole('button', { name: '安全页签：防火墙' }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole('listbox')).toHaveAccessibleName('安全页签')
    expect(screen.getByRole('option', { name: '防火墙' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: '不可用' })).toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('option', { name: 'SSH 管理' }))
    expect(onSelect).toHaveBeenLastCalledWith('ssh')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: '安全页签：SSH 管理' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: '安全页签：SSH 管理' }))
    await user.click(screen.getByRole('option', { name: 'SSH 管理' }))
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  it('方向键跳过禁用项，首尾键和 Enter 选择保持可用', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    screen.getByRole('button', { name: '安全页签：防火墙' }).focus()
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(screen.getByRole('listbox')).toHaveFocus())
    expectActive('防火墙')
    await user.keyboard('{ArrowDown}')
    expectActive('SSH 管理')
    await user.keyboard('{End}')
    expectActive('主机账号')
    await user.keyboard('{Home}')
    expectActive('防火墙')
    await user.keyboard('{ArrowUp}{Enter}')
    expect(onSelect).toHaveBeenLastCalledWith('accounts')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: '安全页签：主机账号' })).toHaveFocus())
  })

  it('Escape 和外部点击关闭菜单，不改变当前值', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    const trigger = screen.getByRole('button', { name: '安全页签：防火墙' })
    await user.click(trigger)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: '下一个控件' }))
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('展开形态或禁用后关闭浮层，不会在再次收纳时残留展开状态', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Harness />)
    await user.click(screen.getByRole('button', { name: '安全页签：防火墙' }))
    rerender(<Harness active={false} />)
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    rerender(<Harness />)
    expect(screen.getByRole('button', { name: '安全页签：防火墙' })).toHaveAttribute('aria-expanded', 'false')
    await user.click(screen.getByRole('button', { name: '安全页签：防火墙' }))
    rerender(<Harness disabled />)
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '安全页签：防火墙' })).toBeDisabled()
  })

  it('保留字母定位和选项激活', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    await user.click(screen.getByRole('button', { name: '安全页签：防火墙' }))
    await user.keyboard('s')
    expectActive('SSH 管理')
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenLastCalledWith('ssh')
  })

  it('Tab 收起菜单并继续前往下一个控件', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    screen.getByRole('button', { name: '安全页签：防火墙' }).focus()
    await user.keyboard('{ArrowUp}')
    expectActive('主机账号')
    await user.keyboard('{Tab}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下一个控件' })).toHaveFocus()
  })

  it('相同显示文案仍按原始身份分别选中，禁用项不能触发回调', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<GooeySelect ariaLabel="终端会话" items={[
      { value: 'session-a', label: '主机终端' },
      { value: 'session-b', label: '主机终端' },
      { value: 'disabled', label: '不可用', disabled: true },
    ]} value="session-b" onSelect={onSelect} />)
    await user.click(screen.getByRole('button', { name: '终端会话：主机终端' }))
    const options = screen.getAllByRole('option', { name: '主机终端' })
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('option', { name: '不可用' }))
    expect(onSelect).not.toHaveBeenCalled()
    await user.click(options[0]!)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('session-a')
  })
})
