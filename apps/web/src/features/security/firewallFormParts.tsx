/*
 * 防火墙三个规则弹窗共用的表单部件与常量。
 * 提交不绑定 form 的回车提交（避开输入法组合回车），只走按钮点击。
 */

export const FIREWALL_INPUT_CLASS =
  'w-full rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle'

export function SegmentedControl<T extends string>({
  groupLabel,
  options,
  value,
  onChange,
}: {
  groupLabel: string
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={groupLabel}
      className="inline-flex overflow-hidden rounded-lg border border-line"
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`whitespace-nowrap px-3 py-1.5 text-xs transition-colors ${
            index > 0 ? 'border-l border-line' : ''
          } ${
            option.value === value
              ? 'bg-surface-raised font-medium text-fg'
              : 'text-fg-muted hover:bg-surface-raised hover:text-fg'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** 端口输入的合法形态：单端口或冒号端口段（8080 / 1000:2000）。 */
export function parsePortInput(raw: string): { port: number; portTo?: number } | { error: string } {
  const trimmed = raw.trim()
  const match = /^(\d{1,5})(?::(\d{1,5}))?$/.exec(trimmed)
  if (!match) {
    return { error: '端口需为 1-65535 的整数，端口段用冒号（如 1000:2000）' }
  }
  const port = Number.parseInt(match[1] ?? '', 10)
  const portToText = match[2]
  const portTo = portToText === undefined ? undefined : Number.parseInt(portToText, 10)
  if (port < 1 || port > 65535) {
    return { error: '端口需为 1-65535 的整数' }
  }
  if (portTo !== undefined) {
    if (portTo < 1 || portTo > 65535) {
      return { error: '端口段结束需为 1-65535 的整数' }
    }
    if (portTo < port) {
      return { error: `端口段无效：结束端口 ${portTo} 小于起始端口 ${port}` }
    }
  }
  return { port, portTo }
}
