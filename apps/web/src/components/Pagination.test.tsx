import * as Tooltip from '@radix-ui/react-tooltip'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Pagination, type PaginationProps } from './Pagination'

function view(props: Partial<PaginationProps> = {}) {
  return <Tooltip.Provider><Pagination label="列表分页" summary="共 240 条" pageSize={20}
    pageCount={12} page={6} onPageChange={() => {}} {...props} /></Tooltip.Provider>
}

describe('共享页码分页', () => {
  it('保留受控页码、摘要和键盘激活，回调后等待调用方更新', async () => {
    const user = userEvent.setup()
    const change = vi.fn()
    const { rerender } = render(view({ page: 1, onPageChange: change }))
    const pager = screen.getByRole('navigation', { name: '列表分页' })
    expect(screen.getByText('共 240 条 · 每页 20 条')).toBeInTheDocument()
    expect(within(pager).getByRole('button', { name: '上一页' })).toBeDisabled()
    await user.click(within(pager).getByRole('button', { name: '3' }))
    expect(change).toHaveBeenCalledExactlyOnceWith(3)
    expect(within(pager).getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'page')
    rerender(view({ page: 3, onPageChange: change }))
    expect(within(pager).getByRole('button', { name: '3' })).toHaveAttribute('aria-current', 'page')
    within(pager).getByRole('button', { name: '下一页' }).focus()
    await user.keyboard('{Enter}')
    expect(change).toHaveBeenCalledTimes(2)
    expect(change).toHaveBeenLastCalledWith(4)
  })

  it('长列表收纳中间页，首尾可达，数据缩减后页码落入有效范围', async () => {
    const user = userEvent.setup()
    const change = vi.fn()
    const { rerender } = render(view({ onPageChange: change }))
    const pager = screen.getByRole('navigation', { name: '列表分页' })
    expect(within(pager).getByRole('button', { name: '1' })).toBeEnabled()
    expect(within(pager).getByRole('button', { name: '12' })).toBeEnabled()
    expect(within(pager).queryByRole('button', { name: '2' })).not.toBeInTheDocument()
    expect(within(pager).getAllByText('…')).toHaveLength(2)
    await user.click(within(pager).getByRole('button', { name: '12' }))
    expect(change).toHaveBeenLastCalledWith(12)
    rerender(view({ page: 12, onPageChange: change }))
    expect(within(pager).getByRole('button', { name: '下一页' })).toBeDisabled()
    rerender(view({ page: 12, pageCount: 2, onPageChange: change }))
    expect(within(pager).getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page')
    await user.click(within(pager).getByRole('button', { name: '上一页' }))
    expect(change).toHaveBeenLastCalledWith(1)
  })

  it('忙碌时禁用所有翻页动作，单页与隐藏前后控制的状态正常', async () => {
    const user = userEvent.setup()
    const change = vi.fn()
    const { rerender } = render(view({ disabled: true, onPageChange: change }))
    const pager = screen.getByRole('navigation', { name: '列表分页' })
    expect(pager).toHaveAttribute('aria-disabled', 'true')
    for (const button of within(pager).getAllByRole('button')) {
      expect(button).toBeDisabled()
      await user.click(button)
    }
    expect(change).not.toHaveBeenCalled()
    rerender(view({ page: 1, pageCount: 1, onPageChange: change }))
    expect(within(pager).getByRole('button', { name: '上一页' })).toBeDisabled()
    expect(within(pager).getByRole('button', { name: '下一页' })).toBeDisabled()
    expect(within(pager).getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'page')
    rerender(view({ page: 1, pageCount: 1, showControls: false }))
    expect(within(pager).queryByRole('button', { name: '上一页' })).not.toBeInTheDocument()
    expect(within(pager).queryByRole('button', { name: '下一页' })).not.toBeInTheDocument()
  })
})
