import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { HeaderTabs } from './HeaderTabs'

/*
 * 指示条的过渡时机：刷新恢复选中页签时必须直接落位，不能从左侧滑过来；
 * 只有在会话内由用户点过页签之后才滑动。jsdom 没有排版，offsetWidth/offsetLeft
 * 恒为 0，因此这两种情形都用假排版（defineProperty）测，测完还原。
 */

const TABS = [
  { value: 'a', label: '甲' },
  { value: 'b', label: '乙' },
] as const

function indicator(): HTMLElement {
  const group = screen.getByRole('group', { name: '测试页签' })
  return group.querySelector('span[aria-hidden="true"]') as HTMLElement
}

/** 假排版：offsetWidth/offsetLeft 返回固定值，供「已量到位置」的用例使用。 */
async function withFakeLayout(run: () => void | Promise<void>): Promise<void> {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 104 })
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', { configurable: true, get: () => 56 })
  try {
    await run()
  } finally {
    delete (HTMLElement.prototype as unknown as { offsetWidth?: unknown }).offsetWidth
    delete (HTMLElement.prototype as unknown as { offsetLeft?: unknown }).offsetLeft
  }
}

describe('HeaderTabs 指示条', () => {
  it('刷新恢复选中页签：指示条直接落在目标位置，不带过渡', async () => {
    await withFakeLayout(() => {
      render(<HeaderTabs items={TABS} value="b" onSelect={() => {}} groupLabel="测试页签" />)

      const bar = indicator()
      expect(bar.style.left).toBe('56px')
      expect(bar.style.width).toBe('104px')
      // 首次落位不挂过渡：挂了的话浏览器会把这个位置变化当成一次动画，从左侧滑过来。
      // 只断言「启用滑动」的那段类名：motion-reduce:transition-none 是降级开关，常驻无害。
      expect(bar.className).not.toContain('transition-[left,width]')
      expect(bar.className).not.toContain('duration-200')
    })
  })

  it('用户点过页签之后才启用过渡：切换时滑动', async () => {
    const user = userEvent.setup()
    await withFakeLayout(async () => {
      render(<HeaderTabs items={TABS} value="a" onSelect={() => {}} groupLabel="测试页签" />)
      expect(indicator().className).not.toContain('transition-[left,width]')

      await user.click(screen.getByRole('button', { name: '乙' }))
      expect(indicator().className).toContain('transition-[left,width]')
      expect(indicator().className).toContain('duration-200')
    })
  })

  it('未量到位置（宽度为 0）时同样不带过渡', () => {
    render(<HeaderTabs items={TABS} value="b" onSelect={() => {}} groupLabel="测试页签" />)

    expect(indicator().className).not.toContain('transition-[left,width]')
    expect(indicator().className).not.toContain('duration-200')
  })
})
