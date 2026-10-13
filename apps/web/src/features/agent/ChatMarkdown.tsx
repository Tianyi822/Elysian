import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// 保持渲染器引用稳定，增量更新时不重新挂载代码块和表格。
const components: Components = {
  a: ({ children, href, title }) => <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>,
  pre: ({ children }) => <pre className="hover-scrollbar" tabIndex={0}>{children}</pre>,
  table: ({ children }) => <div className="chat-markdown-table hover-scrollbar" tabIndex={0}><table>{children}</table></div>,
}
/** 回复按 Markdown 展示，保留默认安全链接处理，不解析模型输出中的 HTML。 */
export function ChatMarkdown({ text }: { text: string }) {
  return <div className="chat-markdown">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{text}</Markdown>
  </div>
}
