import * as Tooltip from '@radix-ui/react-tooltip'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
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
  render(<Tooltip.Provider><SelectDropdown<Value> {...props} /></Tooltip.Provider>)
  return props
}

describe('自绘单选下拉', () => {
  it('搜索在菜单内，输入即时显示，防抖只应用最后一次文字；清空立即恢复且取消待办', async () => {
    const user = userEvent.setup()
    renderDropdown({ search: { ariaLabel: '搜索分类', placeholder: '输入分类' } })
    expect(screen.queryByRole('textbox', { name: '搜索分类' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '操作分类筛选：全部' }))
    const menu = screen.getByRole('menu')
    const input = within(menu).getByRole('textbox', { name: '搜索分类' })
    expect(input).toHaveFocus()
    vi.useFakeTimers()
    try {
      fireEvent.change(input, { target: { value: '安全' } })
      expect(input).toHaveValue('安全')
      act(() => vi.advanceTimersByTime(200))
      fireEvent.change(input, { target: { value: '文件' } })
      act(() => vi.advanceTimersByTime(299))
      expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getAllByRole('menuitemradio')).toHaveLength(1)
      expect(screen.getByRole('menuitemradio', { name: '文件管理' })).toBeInTheDocument()
      expect(input).toHaveFocus()
      expect(screen.getByRole('status')).toHaveTextContent('显示 1 / 3 项')
      fireEvent.change(input, { target: { value: '安全' } })
      fireEvent.click(screen.getByRole('button', { name: '清空搜索' }))
      expect(input).toHaveValue('')
      expect(input).toHaveFocus()
      expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
      act(() => vi.advanceTimersByTime(300))
      expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
    } finally { vi.useRealTimers() }
  })

  it('输入法组合期间不筛选也不选值，结束后才防抖过滤', async () => {
    const user = userEvent.setup()
    const props = renderDropdown({ search: { ariaLabel: '搜索分类', placeholder: '输入分类' } })
    await user.click(screen.getByRole('button', { name: '操作分类筛选：全部' }))
    const input = screen.getByRole('textbox', { name: '搜索分类' })
    vi.useFakeTimers()
    try {
      fireEvent.compositionStart(input)
      fireEvent.change(input, { target: { value: '安全' } })
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
      act(() => vi.advanceTimersByTime(300))
      expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
      expect(props.onSelect).not.toHaveBeenCalled()
      fireEvent.compositionEnd(input)
      act(() => vi.advanceTimersByTime(299))
      expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getAllByRole('menuitemradio')).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  it('搜索输入支持空格与 Enter 立即过滤，方向键选值，Escape 返回触发器且重开清空', async () => {
    const user = userEvent.setup()
    const props = renderDropdown({ search: { ariaLabel: '搜索分类', placeholder: '输入分类' } })
    const trigger = screen.getByRole('button', { name: '操作分类筛选：全部' })
    trigger.focus()
    await user.keyboard('{Enter}')
    await user.type(screen.getByRole('textbox', { name: '搜索分类' }), ' 文件 ')
    await user.keyboard('{Enter}')
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(1)
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitemradio', { name: '文件管理' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('textbox', { name: '搜索分类' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('textbox', { name: '搜索分类' })).toHaveValue('')
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(props.onSelect).toHaveBeenCalledWith('security')
  })

  it('输入后立刻用方向键选值，会先应用搜索再导航，避免选择过滤前的候选项', async () => {
    const user = userEvent.setup()
    const props = renderDropdown({ search: { ariaLabel: '搜索分类', placeholder: '输入分类' } })
    await user.click(screen.getByRole('button', { name: '操作分类筛选：全部' }))
    await user.type(screen.getByRole('textbox', { name: '搜索分类' }), '文件')
    await user.keyboard('{ArrowDown}{Enter}')
    expect(props.onSelect).toHaveBeenCalledWith('files')
  })

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

  it.each([false, true])('鼠标选值后保留焦点但不显示键盘焦点框（搜索：%s），切回键盘时恢复提示', async (searchable) => {
    const user = userEvent.setup()
    renderDropdown(searchable ? { search: { ariaLabel: '搜索分类', placeholder: '输入分类' } } : {})
    const trigger = screen.getByRole('button', { name: '操作分类筛选：全部' })
    await user.click(trigger)
    if (searchable) await user.type(screen.getByRole('textbox', { name: '搜索分类' }), '文件')
    await user.click(screen.getByRole('menuitemradio', { name: '文件管理' }))
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('data-pointer-focus', 'true')
    await user.keyboard('{Enter}{Escape}')
    expect(trigger).toHaveFocus()
    expect(trigger).not.toHaveAttribute('data-pointer-focus')
  })

  it('鼠标打开后用键盘选值，返回触发器时保留键盘焦点提示', async () => {
    const user = userEvent.setup()
    renderDropdown()
    const trigger = screen.getByRole('button', { name: '操作分类筛选：全部' })
    await user.click(trigger)
    await user.keyboard('{ArrowDown}{Enter}')
    expect(trigger).toHaveFocus()
    expect(trigger).not.toHaveAttribute('data-pointer-focus')
  })

  it('候选项文字靠左，选中勾跟在文字后面，未选项左侧不留空列', async () => {
    const user = userEvent.setup()
    renderDropdown()

    await user.click(screen.getByRole('button', { name: '操作分类筛选：全部' }))
    const selected = await screen.findByRole('menuitemradio', { name: '全部' })
    const unselected = screen.getByRole('menuitemradio', { name: '文件管理' })

    expect(selected.firstElementChild).toHaveTextContent('全部')
    expect(selected.querySelector('svg')).not.toBeNull()
    expect(unselected.firstElementChild).toHaveTextContent('文件管理')
    expect(unselected.querySelector('svg')).toBeNull()
    expect(selected).toHaveClass('text-left')
  })

  it('菜单超出高度时滚轮留在列表内，不冒泡到外层滚动锁', async () => {
    const user = userEvent.setup()
    renderDropdown()
    await user.click(screen.getByRole('button', { name: '操作分类筛选：全部' }))
    const scroller = screen.getByRole('menu').firstElementChild as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 800 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 })
    scroller.scrollTop = 40

    const reachedDocument = vi.fn()
    document.addEventListener('wheel', reachedDocument)
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 30, bubbles: true, cancelable: true }))
    document.removeEventListener('wheel', reachedDocument)

    expect(reachedDocument).not.toHaveBeenCalled()
  })

  it('键盘方向键可选值，Escape 关闭菜单并返回触发器', async () => {
    const user = userEvent.setup()
    const props = renderDropdown()
    const trigger = screen.getByRole('button', { name: '操作分类筛选：全部' })
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    await user.keyboard('{Enter}{ArrowDown}{Enter}')
    expect(props.onSelect).toHaveBeenCalledWith('security')
  })

  it('候选项为空时浮层说明原因，不渲染选项', async () => {
    const user = userEvent.setup()
    renderDropdown({
      items: [],
      value: undefined,
      fallbackLabel: '选择容器',
      emptyLabel: '没有可接管的运行中容器',
    })

    await user.click(screen.getByRole('button', { name: '操作分类筛选：选择容器' }))

    expect(await screen.findByText('没有可接管的运行中容器')).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument()
  })

  it('禁用时不打开菜单', async () => {
    const user = userEvent.setup()
    renderDropdown({ disabled: true })
    const trigger = screen.getByRole('button', { name: '操作分类筛选：全部' })
    expect(trigger).toBeDisabled()
    await user.click(trigger)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
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
      'text-accent-fg',
    )
  })

  it('行尾槽里的按钮可点击且不选中该项、不关菜单', async () => {
    const user = userEvent.setup()
    const onTrailing = vi.fn()
    const onSelect = vi.fn()
    renderDropdown({
      onSelect,
      items: [
        { value: 'all', label: '全部', trailing: <button type="button" aria-label="行内动作" onClick={onTrailing}>x</button> },
        { value: 'security', label: '安全设置' },
        { value: 'files', label: '文件管理' },
      ],
    })
    await user.click(screen.getByRole('button', { name: '操作分类筛选：全部' }))
    const option = screen.getByRole('menuitemradio', { name: '全部' })
    await user.click(within(option).getByRole('button', { name: '行内动作' }))
    expect(onTrailing).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole('menuitemradio', { name: '全部' })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitemradio', { name: '文件管理' }))
    expect(onSelect).toHaveBeenCalledWith('files')
  })
})
