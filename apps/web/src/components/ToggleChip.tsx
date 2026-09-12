/**
 * 多选筛选用的勾选标签。用原生复选框承载，键盘与读屏行为都是浏览器自带的，
 * 不做自定义控件那套 focus 管理。
 */
export function ToggleChip({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label
      className={[
        'inline-flex cursor-pointer items-center gap-1.5 rounded border px-2 py-0.5 text-xs',
        checked
          ? 'border-accent bg-accent/10 text-fg'
          : 'border-line bg-surface text-fg-muted hover:text-fg',
      ].join(' ')}
    >
      <input
        type="checkbox"
        className="size-3 accent-accent"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}
