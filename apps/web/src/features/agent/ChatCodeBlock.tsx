import { memo, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { RootContent } from 'hast'
import { Check, Copy } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import { useClipboardCopy } from '../../components/CopyButton'
import { codeLanguageLabel, highlightCode } from './codeHighlight'

function renderTokens(nodes: readonly RootContent[]): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.value
    if (node.type !== 'element') return null
    const classes = node.properties.className
    return <span key={index} className={Array.isArray(classes) ? classes.join(' ') : undefined}>{renderTokens(node.children)}</span>
  })
}

/** 已完成的代码块不随后续流式文字重新着色或挂载。 */
export const ChatCodeBlock = memo(function ChatCodeBlock({ value, language }: { value: string; language: string }) {
  const content = useMemo(() => {
    const tree = highlightCode(value, language)
    return tree ? renderTokens(tree.children) : value
  }, [value, language])
  const { copied, copy } = useClipboardCopy()

  return <div className="chat-code-block">
    <div className="chat-code-toolbar">
      <span className="chat-code-language">{codeLanguageLabel(language)}</span>
      <IconButton label={copied ? '已复制代码' : '复制代码'} variant="ghost" tooltipSide="top" onPress={() => void copy(value, '代码')}>
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </IconButton>
    </div>
    <pre className="hover-scrollbar" tabIndex={0}><code className={language ? `language-${language}` : undefined}>{content}</code></pre>
  </div>
})
