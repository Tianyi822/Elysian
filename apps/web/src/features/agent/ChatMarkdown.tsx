import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChatCodeBlock } from './ChatCodeBlock'

// 保持渲染器引用稳定，增量更新时不重新挂载代码块和表格。
const components: Components = {
  a: ({ children, href, title }) => <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>,
  pre: ({ children, node }) => {
    const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code')
    if (code?.type !== 'element') return <pre className="hover-scrollbar" tabIndex={0}>{children}</pre>
    const classes = code.properties.className
    const languageClass = Array.isArray(classes) ? classes.find(name => typeof name === 'string' && name.startsWith('language-')) : undefined
    const language = typeof languageClass === 'string' ? languageClass.slice('language-'.length).toLowerCase() : ''
    const value = code.children.map(child => child.type === 'text' ? child.value : '').join('')
    return <ChatCodeBlock value={value} language={language} />
  },
  table: ({ children }) => <div className="chat-markdown-table hover-scrollbar" tabIndex={0}><table>{children}</table></div>,
}
/** 回复按 Markdown 展示，保留默认安全链接处理，不解析模型输出中的 HTML。 */
export function ChatMarkdown({ text }: { text: string }) {
  return <div className="chat-markdown">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{text}</Markdown>
  </div>
}
