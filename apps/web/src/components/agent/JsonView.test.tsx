import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { JsonView } from './JsonView'
import { useNotificationStore } from '../../stores/notificationStore'

describe('JsonView 原文呈现', () => {
  it('原文逐字节显示：大整数与键序不经 JSON 往返改变', () => {
    const text = '{"value":9007199254740993,"nested":{"a":1}}'
    const view = render(<JsonView text={text} label="调用参数" />)
    expect(view.container.querySelector('pre')?.textContent).toBe(text)
    expect(screen.getByText('调用参数', { selector: 'span' })).toBeInTheDocument()
  })

  it('超长原文默认折叠并提示省略量，展开后完整显示', async () => {
    const text = `{"pad":"${'x'.repeat(5000)}"}`
    const view = render(<JsonView text={text} label="输入" collapseBytes={1024} />)
    expect(view.container.querySelector('pre')?.textContent).toContain('已折叠')
    expect(view.container.querySelector('pre')?.textContent).not.toContain('x'.repeat(2000))
    await userEvent.click(screen.getByRole('button', { name: '展开全部' }))
    expect(view.container.querySelector('pre')?.textContent).toBe(text)
    await userEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(view.container.querySelector('pre')?.textContent).toContain('已折叠')
  })

  it('复制按钮复制的是原文本身', async () => {
    useNotificationStore.getState().clear()
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    const text = '{"ok":true}'
    render(<JsonView text={text} label="输出" />)
    await userEvent.click(screen.getByTitle('复制输出原文'))
    expect(writeText).toHaveBeenCalledWith(text)
  })
})
