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

const modelItems = [
  { value: 'gpt-5', label: 'gpt-5', description: 'gpt-5' },
  { value: 'qwen3:32b', label: 'qwen3:32b', description: 'qwen3:32b' },
]

const permissionItems = [
  { value: 'ask', label: '请求批准', description: '需要批准的操作，按服务端规则请求确认。' },
  { value: 'assist', label: '帮我批准', description: '自动批准可恢复的工作区写入，以及无宿主写权限、无出网的隔离执行。' },
  { value: 'full', label: '完全开放', description: '自动批准已启用能力所需的操作与运行时权限，系统禁区与资源限制继续生效。' },
]

/** 读出融合表面当前的内联缩放；framer-motion 写 scaleX(..) scaleY(..)，等于 1 的那一个会省略。 */
function collapsedScale(surface: HTMLElement) {
  const transform = surface.style.transform
  if (!transform) return { x: 1, y: 1 }
  if (transform.startsWith('matrix')) {
    const [a, , , d] = transform.slice('matrix('.length, -1).split(',').map(Number)
    return { x: a!, y: d! }
  }
  const value = (axis: string) => Number(new RegExp(`scale${axis}\\(([^)]+)\\)`).exec(transform)?.[1] ?? 1)
  return { x: value('X'), y: value('Y') }
}

describe('GooeySelect 带说明的选项', () => {
  const ROW = 44
  const ROOMY_ROW = 72
  const ROW_GAP = 4
  const PANEL_PAD = 10

  /** jsdom 没有布局：把说明报成两行高，模拟在面板宽度内折行的说明。 */
  function installWrappedDescriptions() {
    const original = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function () {
      const rect = original.call(this)
      if (!this.id.endsWith('-description')) return rect
      return { ...rect, height: 30, bottom: rect.top + 30, toJSON: () => ({}) } as DOMRect
    }
    return () => { HTMLElement.prototype.getBoundingClientRect = original }
  }

  async function openWrappedPermissionMenu() {
    const user = userEvent.setup()
    const restore = installWrappedDescriptions()
    render(<GooeySelect ariaLabel="权限模式" width={336} items={permissionItems} value="ask" onSelect={() => {}} />)
    await user.click(screen.getByRole('button', { name: '权限模式：请求批准' }))
    return restore
  }

  it('说明只有一行时保持上游的行高与面板尺寸', async () => {
    const user = userEvent.setup()
    render(<GooeySelect ariaLabel="选择模型" items={modelItems} value="gpt-5" onSelect={() => {}} />)
    await user.click(screen.getByRole('button', { name: '选择模型：gpt-5' }))
    const list = screen.getByRole('listbox')
    for (const option of screen.getAllByRole('option')) expect(option).toHaveStyle({ minHeight: `${ROW}px` })
    expect(list).toHaveStyle({ width: '306px', maxHeight: `${2 * ROW + PANEL_PAD * 2}px` })
    expect(list).not.toHaveClass('space-y-1')
  })

  it('选项在关闭状态下才加载完成时，收起的面板按最新内容缩放，首次展开从按钮大小起步', async () => {
    const { rerender } = render(<GooeySelect ariaLabel="选择模型" items={[]} onSelect={() => {}} />)
    rerender(<GooeySelect ariaLabel="选择模型" items={modelItems} value="gpt-5" onSelect={() => {}} />)
    // jsdom 没有布局，触发器保持默认的 56px 高；面板高是两行 44px 加上下各 10px 内距。
    await waitFor(() => expect(collapsedScale(screen.getByTestId('gooey-menu-surface')).y).toBeCloseTo(56 / (2 * ROW + PANEL_PAD * 2), 4))
  })

  it('说明折行的菜单在关闭时就按折行后的高度收起，首次展开同样从按钮大小起步', async () => {
    const restore = installWrappedDescriptions()
    try {
      render(<GooeySelect ariaLabel="权限模式" width={336} items={permissionItems} value="ask" onSelect={() => {}} />)
      const surface = screen.getByTestId('gooey-menu-surface')
      const roomyHeight = ROOMY_ROW * permissionItems.length + ROW_GAP * (permissionItems.length - 1) + PANEL_PAD * 2
      await waitFor(() => expect(surface).toHaveStyle({ height: `${roomyHeight}px` }))
      await waitFor(() => expect(collapsedScale(surface).y).toBeCloseTo(56 / roomyHeight, 4))
    } finally {
      restore()
    }
  })

  it('说明折行时选项统一撑高并彼此留出间隔，不再被单行行高挤压', async () => {
    const restore = await openWrappedPermissionMenu()
    try {
      for (const label of ['请求批准', '帮我批准', '完全开放']) {
        const option = screen.getByRole('option', { name: label })
        // 一行标题、4px 间隔、两行 12px/16px 说明，加上下各 8px 内距。
        expect(parseFloat(option.style.minHeight), label).toBeGreaterThanOrEqual(19.4 + 4 + 32 + 16)
      }
      expect(screen.getByRole('listbox')).toHaveClass('space-y-1')
    } finally {
      restore()
    }
  })

  it('说明折行时面板高度正好容下选项，上下留白对称', async () => {
    const restore = await openWrappedPermissionMenu()
    try {
      const maxHeight = `${ROOMY_ROW * permissionItems.length + ROW_GAP * (permissionItems.length - 1) + PANEL_PAD * 2}px`
      expect(screen.getByRole('listbox')).toHaveStyle({ width: '336px', maxHeight })
      expect(screen.getByTestId('gooey-menu-surface')).toHaveStyle({ width: '336px', height: maxHeight })
    } finally {
      restore()
    }
  })

  it('说明折行时圆点留在标题行末尾，选中与否都占同一列', async () => {
    const restore = await openWrappedPermissionMenu()
    try {
      for (const label of ['请求批准', '帮我批准', '完全开放']) {
        const titleRow = screen.getByRole('option', { name: label }).querySelector('span.block')!.parentElement!
        expect(titleRow.lastElementChild, label).toHaveAttribute('aria-hidden', 'true')
      }
    } finally {
      restore()
    }
  })

  it('只有单行标签的菜单保持上游的行高、面板宽度与面板高度', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: '安全页签：防火墙' }))
    for (const option of screen.getAllByRole('option')) {
      expect(option).toHaveStyle({ height: `${ROW}px` })
      // 单行选项只在选中时才出现末尾的圆点，未选中的末尾仍是文字。
      if (option.getAttribute('aria-selected') !== 'true') expect(option.lastElementChild).not.toHaveAttribute('aria-hidden', 'true')
    }
    expect(screen.getByRole('listbox')).toHaveStyle({ maxHeight: `${items.length * ROW + PANEL_PAD * 2}px`, width: '306px' })
    expect(screen.getByRole('listbox')).not.toHaveClass('space-y-1')
  })
})
