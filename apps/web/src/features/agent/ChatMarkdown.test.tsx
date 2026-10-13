import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChatMarkdown } from './ChatMarkdown'

describe('回复 Markdown', () => {
  it('渲染标题、强调、列表、引用、代码、链接与表格', () => {
    const { container } = render(<ChatMarkdown text={'## 检查结果\n\n**正常**，运行 `docker ps`。\n\n- 容器运行中\n- 镜像已就绪\n\n> 仅检查状态\n\n```sh\ndocker ps\ndocker images\n```\n\n[参考文档](https://example.com/docs)\n\n| 服务 | 状态 |\n| --- | --- |\n| Web | 正常 |'} />)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('检查结果')
    expect(container.querySelector('strong')).toHaveTextContent('正常')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(container.querySelector('blockquote')).toHaveTextContent('仅检查状态')
    expect(container.querySelector('pre code')?.textContent).toBe('docker ps\ndocker images\n')
    expect(screen.getByRole('link', { name: '参考文档' })).toHaveAttribute('href', 'https://example.com/docs')
    expect(within(screen.getByRole('table')).getByRole('cell', { name: 'Web' })).toBeInTheDocument()
  })

  it('不执行原始 HTML，不允许脚本链接，保留代码示例中的 HTML 文本', () => {
    const { container } = render(<ChatMarkdown text={'<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n[危险链接](javascript:alert%281%29)\n\n```html\n<script>示例</script>\n```'} />)
    expect(container.querySelector('script, img')).toBeNull()
    expect(screen.getByText('危险链接')).not.toHaveAttribute('href', expect.stringContaining('javascript:'))
    expect(container.querySelector('pre code')).toHaveTextContent('<script>示例</script>')
  })
})
