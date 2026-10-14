import { Check, Copy } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import { useClipboardCopy } from '../../components/CopyButton'

/**
 * 消息行的复制按钮：悬停或键盘聚焦消息行时在气泡下方的条带内浮现（定位见
 * agentChat.css 的 .chat-copy，条带属于消息行盒，内容与按钮之间没有悬停死区），
 * 只复制消息原文——思考过程与工具调用过程不在复制范围。提示浮层固定在图标下方；
 * 成功后图标短暂换成勾并发右上角通知。
 */
export function ChatMessageCopy({ value, noun }: { value: string; noun: string }) {
  const { copied, copy } = useClipboardCopy()
  return (
    <IconButton label={`复制${noun}`} variant="ghost" tooltipSide="bottom" className="chat-copy" onPress={() => void copy(value, noun)}>
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
    </IconButton>
  )
}
