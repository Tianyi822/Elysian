import { useState } from 'react'
import { CopyButton } from '../../components/CopyButton'
import { CTL_SECONDARY } from '../../components/formControl'

/** 模型修订详情的只读 JSON；支持折叠与复制原文。 */

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
