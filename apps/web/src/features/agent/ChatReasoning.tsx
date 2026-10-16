import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight } from '../../components/icons'

/** 收起只显示最新一行；展开在有界区域内跟随更新，手动上滚时保留阅读位置。 */
export function ChatReasoning({ text, active = false }: { text: string; active?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const preview = useRef<HTMLSpanElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const latestLine = text.trimEnd().split(/\r?\n/).at(-1) ?? ''
  const lineNumber = text.trimEnd().split(/\r?\n/).length

  useLayoutEffect(() => {
    if (preview.current) {
      const element = preview.current
      const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
      if (element.scrollTo) element.scrollTo({ left: element.scrollWidth, behavior })
      else element.scrollLeft = element.scrollWidth
    }
    if (expanded && content.current && following.current) content.current.scrollTop = content.current.scrollHeight
  }, [text, expanded])

  if (!text.trim()) return null
  return <div className="chat-thought" data-streaming={active || undefined}>
    <button
      type="button" className="chat-thought-toggle" aria-expanded={expanded} aria-controls={contentId}
      aria-label={expanded ? '收起思考内容' : '展开思考内容'}
      onClick={() => { following.current = true; setExpanded(value => !value) }}
    >
      <ChevronRight size={14} aria-hidden className={expanded ? 'rotate-90' : undefined} />
      {expanded ? <span>思考内容</span> : <span ref={preview} className="chat-thought-preview"><span key={lineNumber} className="chat-thought-line">{latestLine}</span></span>}
    </button>
    {expanded && <div
      id={contentId} ref={content} role="region" aria-label="思考内容" tabIndex={0}
      className="chat-thought-content hover-scrollbar"
      onScroll={event => {
        const element = event.currentTarget
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
      }}
    >{text}</div>}
  </div>
}
