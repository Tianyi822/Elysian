import { render, screen, within } from '@testing-library/react'
import * as Tooltip from '@radix-ui/react-tooltip'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotificationStore } from '../../stores/notificationStore'
import { ChatMarkdown } from './ChatMarkdown'
import * as codeHighlight from './codeHighlight'

function markdown(text: string) {
  return <Tooltip.Provider><ChatMarkdown text={text} /></Tooltip.Provider>
}

beforeEach(() => {
  useNotificationStore.getState().clear()
})

describe('回复 Markdown', () => {
  it('渲染标题、强调、列表、引用、代码、链接与表格', () => {
    const { container } = render(markdown('## 检查结果\n\n**正常**，运行 `docker ps`。\n\n- 容器运行中\n- 镜像已就绪\n\n> 仅检查状态\n\n```sh\ndocker ps\ndocker images\n```\n\n[参考文档](https://example.com/docs)\n\n| 服务 | 状态 |\n| --- | --- |\n| Web | 正常 |'))
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('检查结果')
    expect(container.querySelector('strong')).toHaveTextContent('正常')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(container.querySelector('blockquote')).toHaveTextContent('仅检查状态')
    expect(container.querySelector('pre code')?.textContent).toBe('docker ps\ndocker images\n')
    expect(screen.getByRole('link', { name: '参考文档' })).toHaveAttribute('href', 'https://example.com/docs')
    expect(within(screen.getByRole('table')).getByRole('cell', { name: 'Web' })).toBeInTheDocument()
  })

  it('不执行原始 HTML，不允许脚本链接，保留代码示例中的 HTML 文本', () => {
    const { container } = render(markdown('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n[危险链接](javascript:alert%281%29)\n\n```html\n<script>示例</script>\n```'))
    expect(container.querySelector('script, img')).toBeNull()
    expect(screen.getByText('危险链接')).not.toHaveAttribute('href', expect.stringContaining('javascript:'))
    expect(container.querySelector('pre code')).toHaveTextContent('<script>示例</script>')
  })

  it('按声明语言着色并展示语言名称，行内代码不显示工具栏', () => {
    const { container } = render(markdown('运行 `const port = 48100`。\n\n```TS\nconst port: number = 48100\n```\n\n```json\n{"ready": true}\n```'))
    expect(screen.getByText('TypeScript')).toBeInTheDocument()
    expect(screen.getByText('JSON')).toBeInTheDocument()
    expect(container.querySelector('pre code.language-ts .hljs-keyword')).toHaveTextContent('const')
    expect(container.querySelector('pre code.language-json .hljs-attr')).toHaveTextContent('"ready"')
    expect(container.querySelector('p code')?.children).toHaveLength(0)
    expect(screen.getAllByRole('button', { name: '复制代码' })).toHaveLength(2)
  })

  it('未知语言和未注明语言保留完整文本且仍可复制', () => {
    const { container } = render(markdown('```unknown-lang\n<x> & y\n```\n\n    indentation\n'))
    expect(screen.getByText('unknown-lang')).toBeInTheDocument()
    expect(screen.getByText('纯文本')).toBeInTheDocument()
    const blocks = container.querySelectorAll('pre code')
    expect(blocks[0]?.textContent).toBe('<x> & y\n')
    expect(blocks[1]?.textContent).toBe('indentation\n')
    expect(container.querySelector('[class^="hljs-"]')).toBeNull()
    expect(screen.getAllByRole('button', { name: '复制代码' })).toHaveLength(2)
  })

  it('逐块复制代码原文，键盘可操作并显示成功反馈', async () => {
    const user = userEvent.setup()
    render(markdown('```python\n  print("你好")\n\n```\n\n```sh\necho second\n```'))
    await user.tab()
    expect(screen.getAllByRole('button', { name: '复制代码' })[0]).toHaveFocus()
    await user.keyboard('{Enter}')
    await expect(navigator.clipboard.readText()).resolves.toBe('  print("你好")\n\n')
    expect(screen.getByRole('button', { name: '已复制代码' })).toBeInTheDocument()
    expect(useNotificationStore.getState().notifications[0]?.message).toBe('已复制代码')
    await user.click(screen.getByRole('button', { name: '复制代码' }))
    await expect(navigator.clipboard.readText()).resolves.toBe('echo second\n')
  })

  it('代码复制被拒时显示错误反馈', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'))
    render(markdown('```sh\necho safe\n```'))
    await user.click(screen.getByRole('button', { name: '复制代码' }))
    expect(useNotificationStore.getState().notifications[0]?.message).toContain('复制失败')
  })

  it('流式未闭合围栏增量更新不重新挂载，后续文字不重复着色已完成代码', () => {
    const highlight = vi.spyOn(codeHighlight, 'highlightCode')
    const view = render(markdown('```ts\nconst port'))
    const pre = view.container.querySelector('pre')!
    pre.scrollLeft = 40
    view.rerender(markdown('```ts\nconst port = 48100\n```'))
    expect(view.container.querySelector('pre')).toBe(pre)
    expect(pre.scrollLeft).toBe(40)
    expect(pre.querySelector('.hljs-number')).toHaveTextContent('48100')
    const calls = highlight.mock.calls.length
    view.rerender(markdown('```ts\nconst port = 48100\n```\n\n接下来检查容器。'))
    expect(highlight).toHaveBeenCalledTimes(calls)
    expect(view.container.querySelector('pre')).toBe(pre)
    highlight.mockRestore()
  })
})
