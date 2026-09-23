import { memo } from 'react'
import { segmentTerminalText } from './terminalSession'

/** 码点全在组合附加符区段之前的文本没有宽字符与零宽字符，可以原样输出。 */
const NARROW_ONLY = /^[\x00-\u02ff]*$/

/**
 * 按终端栅格渲染一段文本：宽字符（中文、全角、emoji）各占一个固定两格宽的盒子。
 * 等宽字体里中文字形不是两个半角宽，不固定就与按两格补位的表格、ls、column -t 输出错列。
 */
export const TerminalText = memo(function TerminalText({ text }: { text: string }) {
  if (NARROW_ONLY.test(text)) return text
  return segmentTerminalText(text).map((segment, index) =>
    segment.wide ? (
      <span key={index} className="inline-block w-[2ch] text-center">
        {segment.text}
      </span>
    ) : (
      segment.text
    ),
  )
})
