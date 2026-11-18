import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATABASE_TAB_ENGINES } from '@elysian/contracts'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useDatabaseStore } from '../../stores/databaseStore'
import { renderApp } from '../../test/renderApp'
import { stubNarrowViewport } from '../../test/viewport'

/**
 * 数据库域在 gateway 里固定走 http adapter，jsdom 下 fetch 不可达；
 * 用例只断言顶栏页签，数据区给一个空列表 fake，避免页面落进错误态的无关噪音。
 */
function switchGateway(): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  return {
    ...base,
    databases: Object.assign(Object.create(base.databases), {
      list: async () => [],
      listSqlite: async () => [],
    }),
  }
}

/** 内容区的平铺分段控件与窄屏下拉。 */
function segmentGroup(): HTMLElement {
  return within(screen.getByRole('main')).getByRole('group', { name: '数据库类型' })
}

/** 平铺形态的容器：宽度够时它参与顶栏布局，摆不下时整体隐藏。 */
function segmentSlot(): HTMLElement {
  return segmentGroup().parentElement as HTMLElement
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: /数据库类型/, hidden: true })
}

function gooeyControl(): HTMLElement {
  return trigger().closest('.easyui-gooey-menu') as HTMLElement
}

beforeEach(() => {
  useDatabaseStore.setState({ engine: 'MariaDB' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('数据库类型切换', () => {
  it('平铺三个容器引擎页签，SQLite 是固定分区不占页签', () => {
    renderApp('/databases', { gateway: switchGateway() })

    const items = within(segmentGroup()).getAllByRole('button')
    expect(items.map((item) => item.textContent)).toEqual([
      'MariaDB',
      'MySQL',
      'Redis',
    ])
    expect(DATABASE_TAB_ENGINES).not.toContain('SQLite')
    expect(items[0]).toHaveAttribute('aria-pressed', 'true')
  })

  it('点击平铺项切换当前引擎，选中态随点击移动', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: switchGateway() })

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

  it('页面未关闭时往返其他页面仍停在上次引擎，重新打开面板回到第一个', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/databases', { gateway: switchGateway() })

    await user.click(within(segmentGroup()).getByRole('button', { name: 'MySQL' }))

    // 会话内记忆：切到别的页面再回来，store 单例保留上次引擎。
    await act(async () => { await router.navigate('/') })
    await act(async () => { await router.navigate('/databases') })
    expect(within(segmentGroup()).getByRole('button', { name: 'MySQL' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(useDatabaseStore.getState().engine).toBe('MySQL')

    // 关闭页面后重新打开等于新的页面会话：内存回到初始值，引擎回到第一个。
    act(() => { useDatabaseStore.setState({ engine: 'MariaDB' }) })
    expect(within(segmentGroup()).getByRole('button', { name: 'MariaDB' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('窄屏下拉由界面自绘：展开可选，选中后收起并更新当前项', async () => {
    const user = userEvent.setup()
    stubNarrowViewport()
    renderApp('/databases', { gateway: switchGateway() })

    await user.click(trigger())

    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(DATABASE_TAB_ENGINES.length)
    expect(options.map((option) => option.textContent)).toEqual([...DATABASE_TAB_ENGINES])
    expect(screen.getByRole('option', { name: 'MariaDB' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    await user.click(screen.getByRole('option', { name: 'MySQL' }))

    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(gooeyControl()).toHaveTextContent('MySQL')
    expect(within(segmentGroup()).getByRole('button', { name: 'MySQL' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('内容区放得下三个引擎时保持平铺，只藏胶囊菜单', () => {
    // jsdom 量不出任何宽度、也没有媒体查询，按「宽屏且放得下」处理：平铺参与布局，下拉只在收起时出场。
    renderApp('/databases', { gateway: switchGateway() })

    expect(segmentSlot()).not.toHaveClass('hidden')
    expect(gooeyControl()).toHaveClass('hidden')
  })

  it('三个引擎超出可用宽度时收起，改显胶囊菜单', () => {
    // 判断依据是真实宽度，jsdom 里一切尺寸都是 0（视口按宽屏算）：把窄屏导航触发器量成工具行装不下的宽度，
    // 引擎切换的可用宽度不足时应收成下拉。
    const original = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const rect = original.call(this)
      if (this.querySelector('[aria-label="打开主导航"]')) {
        Object.defineProperty(rect, 'width', { value: 5000 })
      }
      return rect
    })

    try {
      renderApp('/databases', { gateway: switchGateway() })

      expect(segmentSlot()).toHaveClass('hidden')
      expect(gooeyControl()).not.toHaveClass('hidden')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('视口窄于 768px 时一律收进下拉：顶栏放得下也不平铺', async () => {
    const user = userEvent.setup()
    stubNarrowViewport()

    renderApp('/databases', { gateway: switchGateway() })

    expect(segmentSlot()).toHaveClass('hidden')
    expect(gooeyControl()).not.toHaveClass('hidden')

    await user.click(trigger())
    await user.click(await screen.findByRole('option', { name: 'Redis' }))

    expect(useDatabaseStore.getState().engine).toBe('Redis')
    expect(gooeyControl()).toHaveTextContent('Redis')
  })
})
