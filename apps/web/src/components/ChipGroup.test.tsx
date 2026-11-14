import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChipGroup } from './ChipGroup'

/* 单选分段复用全局胶囊导航，覆盖受控回调、禁用和分组语义。 */

const ITEMS = [
  { value: 'a', label: '甲' },
  { value: 'b', label: '乙' },
] as const

function group(): HTMLElement {
  return screen.getByRole('group', { name: '测试单选' })
}

describe('ChipGroup', () => {
  it('分组带无障碍名，选中底色是一块 aria-hidden 的滑块，成员只报选中态', () => {
    render(<ChipGroup ariaLabel="测试单选" items={ITEMS} value="a" onSelect={() => {}} />)

    expect(group()).toHaveAttribute('data-easyui', 'pill-navigation')
    const slider = group().querySelector('[data-easyui-indicator]') as HTMLElement
    expect(slider).toHaveAttribute('aria-hidden', 'true')
    expect(slider).toHaveClass('absolute', 'rounded-full', 'bg-fg')

    const items = within(group()).getAllByRole('button')
    expect(items.map((item) => item.textContent)).toEqual(['甲', '乙'])
    expect(items[0]).toHaveAttribute('aria-pressed', 'true')
    expect(items[1]).toHaveAttribute('aria-pressed', 'false')
  })

  it('点击成员把选中值交回调用方；整组禁用时成员不可点', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const { rerender } = render(
      <ChipGroup ariaLabel="测试单选" items={ITEMS} value="a" onSelect={onSelect} />,
    )

    await user.click(within(group()).getByRole('button', { name: '乙' }))
    expect(onSelect).toHaveBeenCalledWith('b')

    rerender(<ChipGroup ariaLabel="测试单选" items={ITEMS} value="a" onSelect={onSelect} disabled />)
    for (const item of within(group()).getAllByRole('button')) {
      expect(item).toBeDisabled()
    }
  })

  it('语境类名分别落在容器与成员上', () => {
    render(
      <ChipGroup
        ariaLabel="测试单选"
        items={ITEMS}
        value="a"
        onSelect={() => {}}
        className="mt-4 max-w-full"
        itemClassName="sm:text-sm"
      />,
    )

    expect(group()).toHaveClass('mt-4', 'max-w-full')
    for (const item of within(group()).getAllByRole('button')) {
      expect(item).toHaveClass('rounded-full', 'sm:text-sm')
    }
  })
})
