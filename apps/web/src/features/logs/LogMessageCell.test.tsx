import * as Tooltip from '@radix-ui/react-tooltip'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { LogMessageCell } from './LogMessageCell'

/*
 * 悬浮窗的行为契约：图标始终可聚焦（opacity-0 不是隐藏 DOM）、点击开、Esc 关且焦点回触发器。
 * 这三条对应的正是「点了没反应」这类结构性缺陷，脱离面板单独锁住。
 */

const TEXT = '证书 demo.elysian.local 距到期还有 21 天：自动续期已排入下一个维护窗口'

function renderCell(ui: ReactElement) {
  return render(
    <Tooltip.Provider delayDuration={0}>
      <table>
        <tbody>
          <tr>{ui}</tr>
        </tbody>
      </table>
    </Tooltip.Provider>,
  )
}

function expandButton(): HTMLElement {
  return screen.getByRole('button', { name: '查看完整内容' })
}

describe('日志正文单元格', () => {
  it('正文单行省略：DOM 里是全文，视觉靠 truncate，不写 title 免得与悬浮窗打架', () => {
    renderCell(<LogMessageCell text={TEXT} />)

    const text = screen.getByText(TEXT)
    expect(text).toHaveClass('truncate')
    expect(text).not.toHaveAttribute('title')
  })

  it('点击展开图标弹出悬浮窗，触发器 aria-expanded 同步为 true', async () => {
    const user = userEvent.setup()
    renderCell(<LogMessageCell text={TEXT} />)

    const trigger = expandButton()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)

    const popover = await screen.findByLabelText('完整日志内容')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(popover).toHaveTextContent(TEXT)
    expect(popover).toHaveTextContent('复制全文')
  })

  it('Esc 关闭悬浮窗，焦点回到触发它的图标按钮', async () => {
    const user = userEvent.setup()
    renderCell(<LogMessageCell text={TEXT} />)

    const trigger = expandButton()
    await user.click(trigger)
    await screen.findByLabelText('完整日志内容')

    await user.keyboard('{Escape}')

    expect(screen.queryByLabelText('完整日志内容')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('图标按钮可被键盘 Tab 聚焦（opacity-0 不阻碍聚焦），回车打开悬浮窗', async () => {
    const user = userEvent.setup()
    renderCell(<LogMessageCell text={TEXT} />)

    await user.tab()
    const trigger = expandButton()
    expect(trigger).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(await screen.findByLabelText('完整日志内容')).toHaveTextContent(TEXT)
  })

  it('正文很长时在正文区内部滚动，不撑破视口', async () => {
    const user = userEvent.setup()
    const longText = `${TEXT} ${'重复正文'.repeat(400)}`
    renderCell(<LogMessageCell text={longText} />)

    await user.click(expandButton())
    const popover = await screen.findByLabelText('完整日志内容')
    expect(popover).toHaveClass('max-h-[calc(100vh-2rem)]', 'w-[min(40rem,calc(100vw-2rem))]')

    const body = within(popover).getByText(longText)
    expect(body).toHaveClass('max-h-64', 'overflow-y-auto', 'whitespace-pre-wrap', 'break-all')
  })
})
