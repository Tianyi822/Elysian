import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { HeaderTabs } from './HeaderTabs'

/*
 * 选中态是一块滑块：位置与尺寸从选中按钮量出，用户点过之后才带过渡。
 * jsdom 没有排版，offset* 恒为 0，因此位置类断言都走假排版（defineProperty），测完还原。
 */

const TABS = [
  { value: 'a', label: '甲' },
  { value: 'b', label: '乙' },
] as const

function thumb(): HTMLElement {
  const group = screen.getByRole('group', { name: '测试页签' })
  return group.querySelector('span[aria-hidden="true"]') as HTMLElement
}

/** 受控用法：选中值由调用方持有，HeaderTabs 自己不记账。 */
function Controlled() {
  const [value, setValue] = useState<'a' | 'b'>('a')
  return <HeaderTabs items={TABS} value={value} onSelect={setValue} groupLabel="测试页签" />
}

/**
 * 假排版：两项各占 104×36，第一项贴左上角，第二项排在它右边（左 116）。
 * 位置随按钮文字变，滑块「滑到选中项」才有得断言。
 */
async function withFakeLayout(run: () => void | Promise<void>): Promise<void> {
  const define = (name: string, value: number | ((element: HTMLElement) => number)) => {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return typeof value === 'function' ? value(this) : value
      },
    })
  }
  define('offsetWidth', 104)
  define('offsetHeight', 36)
  define('offsetTop', 4)
  define('offsetLeft', (element) => ((element.textContent ?? '') === '乙' ? 116 : 4))
  try {
    await run()
  } finally {
    for (const name of ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft']) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    }
  }
}

describe('HeaderTabs 选中滑块', () => {
  it('首次渲染滑块贴在选中项上，不带过渡', async () => {
    await withFakeLayout(() => {
      render(<HeaderTabs items={TABS} value="b" onSelect={() => {}} groupLabel="测试页签" />)

      const slider = thumb()
      expect(slider).toHaveClass('bg-nav-selected', 'absolute')
      expect(slider.style.left).toBe('116px')
      expect(slider.style.top).toBe('4px')
      expect(slider.style.width).toBe('104px')
      expect(slider.style.height).toBe('36px')
      // 首次落位不挂过渡：挂了的话浏览器会把这个位置变化当成一次动画，从左侧滑过来。
      // 只断言「启用滑动」的那段类名：motion-reduce:transition-none 是降级开关，常驻无害。
      expect(slider.className).not.toContain('transition-[left,top,width,height]')
      expect(slider.className).not.toContain('duration-200')
    })
  })

  it('底色由滑块独占：选中按钮只有亮色文字，自己不带底色', () => {
    render(<HeaderTabs items={TABS} value="a" onSelect={() => {}} groupLabel="测试页签" />)

    const selected = screen.getByRole('button', { name: '甲' })
    expect(selected).toHaveClass('text-accent-fg')
    expect(selected).not.toHaveClass('bg-nav-selected')
    expect(thumb()).toHaveClass('bg-nav-selected')
  })

  it('用户点过页签之后才启用过渡，滑块滑到新选中项', async () => {
    const user = userEvent.setup()
    await withFakeLayout(async () => {
      render(<Controlled />)
      expect(thumb().style.left).toBe('4px')
      expect(thumb().className).not.toContain('transition-[left,top,width,height]')

      await user.click(screen.getByRole('button', { name: '乙' }))

      expect(screen.getByRole('button', { name: '乙' })).toHaveAttribute('aria-pressed', 'true')
      expect(thumb().style.left).toBe('116px')
      expect(thumb().className).toContain('transition-[left,top,width,height]')
      expect(thumb().className).toContain('duration-200')
    })
  })

  it('选中值不在项里时把滑块收成 0，不在别的页签下留一块底色', () => {
    render(
      <HeaderTabs items={TABS} value={'c' as 'a'} onSelect={() => {}} groupLabel="测试页签" />,
    )

    expect(thumb().style.width).toBe('0px')
    expect(thumb().style.height).toBe('0px')
  })
})
