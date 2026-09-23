import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SelectDropdown } from './SelectDropdown'

/**
 * 自绘单选下拉：触发器只显当前值并带字段名前缀，浮层里选值后回传，
 * 有筛选生效时触发器进入 accent 态。不使用原生 select，因此断言的是按钮与菜单项角色。
 */

const ITEMS = [
  { value: 'all', label: '全部' },
  { value: 'security', label: '安全设置' },
  { value: 'files', label: '文件管理' },
] as const

type Value = (typeof ITEMS)[number]['value']

function renderDropdown(overrides: Partial<Parameters<typeof SelectDropdown<Value>>[0]> = {}) {
  const props = {
    ariaLabel: '操作分类筛选',
    label: '分类',
    items: ITEMS,
    value: 'all' as Value,
    onSelect: vi.fn(),
    ...overrides,
  }
  render(<SelectDropdown<Value> {...props} />)
  return props
}

describe('自绘单选下拉', () => {
  it('触发器同时显示字段名与当前值，aria-label 把两者拼在一起', () => {
    renderDropdown()

    const trigger = screen.getByRole('button', { name: '操作分类筛选：全部' })
    expect(trigger).toHaveTextContent('分类')
    expect(trigger).toHaveTextContent('全部')
  })

  it('未选值时显示占位文案', () => {
    renderDropdown({ value: undefined, fallbackLabel: '请选择版本' })

    expect(screen.getByRole('button', { name: '操作分类筛选：请选择版本' })).toBeInTheDocument()
  })

  it('点开浮层选值：回传选中项，选中项带勾选标记', async () => {
    const user = userEvent.setup()
    const props = renderDropdown()

    await user.click(screen.getByRole('button', { name: '操作分类筛选：全部' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '文件管理' }))

    expect(props.onSelect).toHaveBeenCalledWith('files')
  })

  it('active 时触发器进入 accent 描边态，未激活时不走 accent', () => {
    const { rerender } = render(
      <SelectDropdown<Value> ariaLabel="操作分类筛选" items={ITEMS} value="all" onSelect={() => {}} />,
    )
    expect(screen.getByRole('button', { name: '操作分类筛选：全部' })).not.toHaveClass(
      'bg-accent/10',
    )

    rerender(
      <SelectDropdown<Value>
        ariaLabel="操作分类筛选"
        label="分类"
        active
        items={ITEMS}
        value="files"
        onSelect={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: '操作分类筛选：文件管理' })).toHaveClass(
      'border-accent/50',
      'bg-accent/10',
      'text-accent',
    )
  })
})
