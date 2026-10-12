import { useState } from 'react'
import { CopyButton } from '../CopyButton'
import { CTL_SECONDARY } from '../formControl'

/*
 * JSON 原文只读呈现。argumentsJson、inputJson/outputJson、literalJson、
 * *SchemaJson 等字段是服务端权威字符串：绝不 JSON.parse 后重新序列化来决定显示
 * 内容——大整数与键序会经 float64/对象重排丢真。原文按字节保留展示；
 * 超过折叠阈值的原文默认只显示前段，用户点「展开全部」才渲染完整内容，
 * 长对话与长 JSON 因此保持可读且不卡顿。复制复制的是原文本身。
 */

const DEFAULT_COLLAPSE_BYTES = 4096

export function JsonView({
  text,
  label = 'JSON',
  collapseBytes = DEFAULT_COLLAPSE_BYTES,
}: {
  /** 服务端原文；空串也如实显示。 */
  text: string
  /** 无障碍名与复制提示用的字段名（如「调用参数」）。 */
  label?: string
  /** 超过该字节数默认折叠，展开后完整显示。 */
  collapseBytes?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const collapsible = text.length > collapseBytes
  const visible = collapsible && !expanded ? text.slice(0, collapseBytes) : text
  const omitted = text.length - visible.length

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-fg-muted">{label}</span>
        <CopyButton label={label} value={text} tooltip={`复制${label}原文`} />
      </div>
      <pre className="max-h-96 overflow-auto rounded-lg border border-line bg-surface p-2 font-mono text-xs whitespace-pre-wrap break-all text-fg">
        {visible}
        {omitted > 0 ? (
          <span className="text-fg-subtle">{`\n…（已折叠 ${omitted} 个字符）`}</span>
        ) : null}
      </pre>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={`${CTL_SECONDARY} self-start px-2`}
        >
          {expanded ? '收起' : '展开全部'}
        </button>
      ) : null}
    </div>
  )
}
