import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChipGroup } from './ChipGroup'

/*
 * 滑块的落位与过渡时机在 components/slidingThumb.ts，由 HeaderTabs.test 覆盖同一套机制；
 * 这里守芯片单选组自己的部分：分组语义、选中底色只由滑块承担、点击把值交回去、禁用整组。
 */

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

    // 位置与底色由控件层的 .ctl-chip-thumb 承担（jsdom 不加载样式表，这里只认类名与位置数据）。
    const slider = group().querySelector('span[aria-hidden="true"]') as HTMLElement
    expect(slider).toHaveClass('ctl-chip-thumb')
    expect(slider.style.left).toBe('0px')

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

    expect(group()).toHaveClass('ctl-group', 'mt-4', 'max-w-full')
    for (const item of within(group()).getAllByRole('button')) {
      expect(item).toHaveClass('ctl', 'ctl-chip', 'sm:text-sm')
    }
  })
})
