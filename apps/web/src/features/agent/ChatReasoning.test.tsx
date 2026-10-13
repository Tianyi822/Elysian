import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatReasoning } from './ChatReasoning'

describe('折叠思考内容', () => {
  it('折叠时长行平滑跟随尾部，新行替换为最新一行', () => {
    const { rerender } = render(<ChatReasoning text="开始分析" />)
    const preview = screen.getByRole('button', { name: '展开思考内容' }).querySelector('.chat-thought-preview')!
    const scrollTo = vi.fn()
    Object.defineProperties(preview, { scrollWidth: { value: 900 }, scrollTo: { value: scrollTo } })
    rerender(<ChatReasoning text={'开始分析，' + '继续补充内容。'.repeat(20)} />)
    expect(scrollTo).toHaveBeenCalledWith({ left: 900, behavior: 'smooth' })
    rerender(<ChatReasoning text={'开始分析\n下一步检查配置'} />)
    expect(preview).toHaveTextContent('下一步检查配置')
    expect(preview).not.toHaveTextContent('开始分析')
  })

  it('默认只显示最新一行，展开保留完整文本且更新不重置折叠选择', () => {
    const { rerender } = render(<ChatReasoning text={'第一行\n最新一行\n'} />)
    const button = screen.getByRole('button', { name: '展开思考内容' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveTextContent('最新一行')
    expect(screen.queryByText('第一行')).not.toBeInTheDocument()
    fireEvent.click(button)
    expect(screen.getByRole('region', { name: '思考内容' }).textContent).toBe('第一行\n最新一行\n')
    rerender(<ChatReasoning text={'第一行\n最新一行\n新内容'} />)
    expect(screen.getByRole('button', { name: '收起思考内容' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: '思考内容' })).toHaveTextContent('新内容')
    fireEvent.click(screen.getByRole('button', { name: '收起思考内容' }))
    expect(screen.getByRole('button', { name: '展开思考内容' })).toHaveTextContent('新内容')
    expect(screen.queryByRole('region', { name: '思考内容' })).not.toBeInTheDocument()
  })

  it('展开时跟随新内容滚动，手动向上阅读时不抢走位置', () => {
    const { rerender } = render(<ChatReasoning text="第一行" />)
    fireEvent.click(screen.getByRole('button', { name: '展开思考内容' }))
    const region = screen.getByRole('region', { name: '思考内容' })
    Object.defineProperties(region, { scrollHeight: { value: 500, configurable: true }, clientHeight: { value: 192 } })
    rerender(<ChatReasoning text={'第一行\n第二行'} />)
    expect(region.scrollTop).toBe(500)
    region.scrollTop = 0
    fireEvent.scroll(region)
    rerender(<ChatReasoning text={'第一行\n第二行\n第三行'} />)
    expect(region.scrollTop).toBe(0)
    region.scrollTop = 308
    fireEvent.scroll(region)
    Object.defineProperty(region, 'scrollHeight', { value: 600 })
    rerender(<ChatReasoning text={'第一行\n第二行\n第三行\n第四行'} />)
    expect(region.scrollTop).toBe(600)
  })

  it('没有思考内容时不渲染占位提示', () => {
    const { container } = render(<ChatReasoning text={'  \n'} />)
    expect(container).toBeEmptyDOMElement()
  })
})
