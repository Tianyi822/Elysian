import { render, screen } from '@testing-library/react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { describe, expect, it, vi } from 'vitest'
import { ChatResponse } from './ChatResponse'

describe('回复过渡', () => {
  it.each(['content', 'reasoning'] as const)('等待首段输出时显示动画，收到 %s 后原位衔接', async field => {
    const onProgress = vi.fn()
    const response = (text: string) => <Tooltip.Provider><ChatResponse content="" reasoning="" active onProgress={onProgress} {...{ [field]: text }} /></Tooltip.Provider>
    const view = render(response(''))
    const indicator = screen.getByRole('status', { name: '等待模型回复' })
    expect(indicator).toHaveClass('chat-response-waiting')
    const container = indicator.parentElement
    view.rerender(response('第一段输出'))
    expect(await screen.findByText('第一段输出')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '等待模型回复' })).not.toBeInTheDocument()
    expect(document.querySelector('.chat-response')).toBe(container)
    expect(onProgress).toHaveBeenCalled()
  })

  it('空闲、停止中和已停止的空回复不显示等待动画', () => {
    const onProgress = vi.fn()
    const view = render(<ChatResponse content="" reasoning="" active={false} onProgress={onProgress} />)
    expect(view.container).toBeEmptyDOMElement()
    view.rerender(<ChatResponse content="" reasoning="" active stopping onProgress={onProgress} />)
    expect(view.container).toBeEmptyDOMElement()
    view.rerender(<ChatResponse content="" reasoning="" active stopped onProgress={onProgress} />)
    expect(screen.getByRole('status')).toHaveTextContent('已停止')
    expect(screen.queryByRole('status', { name: '等待模型回复' })).not.toBeInTheDocument()
  })
})
