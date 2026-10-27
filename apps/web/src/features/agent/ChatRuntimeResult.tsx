import { ChatMarkdown } from './ChatMarkdown'
import { ChatMessageCopy } from './ChatMessageCopy'

/** 来自运行内核的终态结果，独立于模型生成的正文与工具过程。 */
export function ChatRuntimeResult({ content }: { content: string }) {
  return <article className="chat-message chat-message-assistant chat-runtime-result" aria-label="运行结果">
    <div className="chat-message-body">
      <p className="chat-result-label">运行结果</p>
      <ChatMarkdown text={content} />
    </div>
    <ChatMessageCopy value={content} noun="运行结果" />
  </article>
}
