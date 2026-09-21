import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DATABASE_ENGINES } from '@elysian/contracts'
import { resolveViewTab, writeStoredViewTab } from '../../app/theme/themePreferences'
import { useDatabaseStore } from '../../stores/databaseStore'
import { renderApp } from '../../test/renderApp'

/** 顶栏的平铺分段控件，与窄屏下拉在同一个 banner 内。 */
function segmentGroup(): HTMLElement {
  return within(screen.getByRole('banner')).getByRole('group', { name: '数据库类型' })
}

/** 平铺形态的容器：宽度够时它参与顶栏布局，摆不下时整体隐藏。 */
function segmentSlot(): HTMLElement {
  return segmentGroup().parentElement as HTMLElement
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: /数据库类型/ })
}

beforeEach(() => {
  useDatabaseStore.setState({ engine: 'MariaDB' })
})

describe('数据库类型切换', () => {
  it('按首字母升序平铺四个类型，不含 SQLServer', () => {
    renderApp('/databases')

    const items = within(segmentGroup()).getAllByRole('button')
    expect(items.map((item) => item.textContent)).toEqual([
      'MariaDB',
      'MySQL',
      'Redis',
      'SQLite',
    ])
    expect(DATABASE_ENGINES).not.toContain('SQLServer')
    expect(items[0]).toHaveAttribute('aria-pressed', 'true')
  })

  it('点击平铺项切换当前类型，选中态随点击移动', async () => {
    const user = userEvent.setup()
    renderApp('/databases')

    await user.click(within(segmentGroup()).getByRole('button', { name: 'Redis' }))

    expect(within(segmentGroup()).getByRole('button', { name: 'Redis' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(segmentGroup()).getByRole('button', { name: 'MariaDB' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(useDatabaseStore.getState().engine).toBe('Redis')
  })

  it('刷新后仍选中上次的类型', () => {
    writeStoredViewTab(window.localStorage, 'database', 'SQLite')
    useDatabaseStore.setState({
      engine: resolveViewTab(window.localStorage, 'database', DATABASE_ENGINES, 'MariaDB'),
    })

    renderApp('/databases')

    expect(within(segmentGroup()).getByRole('button', { name: 'SQLite' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(segmentGroup()).getByRole('button', { name: 'MariaDB' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('窄屏下拉由界面自绘：展开可选，选中后收起并更新当前项', async () => {
    const user = userEvent.setup()
    renderApp('/databases')

    await user.click(trigger())

    const options = await screen.findAllByRole('menuitemradio')
    expect(options).toHaveLength(DATABASE_ENGINES.length)
    expect(options.map((option) => option.textContent)).toEqual([...DATABASE_ENGINES])
    expect(screen.getByRole('menuitemradio', { name: 'MariaDB' })).toHaveAttribute(
      'aria-checked',
      'true',
    )

    await user.click(screen.getByRole('menuitemradio', { name: 'SQLite' }))

    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument()
    expect(trigger()).toHaveTextContent('SQLite')
    expect(within(segmentGroup()).getByRole('button', { name: 'SQLite' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('顶栏放得下六个类型时保持平铺，只藏下拉', () => {
    // jsdom 量不出任何宽度，按「放得下」处理：平铺参与布局，下拉只在收起时出场。
    renderApp('/databases')

    expect(segmentSlot()).not.toHaveClass('hidden')
    expect(trigger()).toHaveClass('hidden')
  })

  it('六个类型挤到右侧功能簇时才收起，改显自绘下拉', () => {
    // 判断依据是真实宽度，jsdom 里一切尺寸都是 0：把右侧功能簇量成顶栏装不下的宽度，
    // 等价于「六个类型已经顶到功能簇」，此时应让位收成下拉。
    const original = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const rect = original.call(this)
      if (this.querySelector('[aria-label="平台内存占用"]')) {
        Object.defineProperty(rect, 'width', { value: 5000 })
      }
      return rect
    })

    try {
      renderApp('/databases')

      expect(segmentSlot()).toHaveClass('hidden')
      expect(trigger()).not.toHaveClass('hidden')
    } finally {
      vi.restoreAllMocks()
    }
  })
})
