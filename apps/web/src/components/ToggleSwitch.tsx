import { LiquidToggle } from './easyui/LiquidToggle'
import { cn } from './easyui/utils'

export interface ToggleSwitchProps {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  busy?: boolean
  compact?: boolean
  className?: string
}

/** 全局布尔设置开关：展示由 EasyUI 承载，确认、保存与失败回读由原调用方处理。 */
export function ToggleSwitch({ label, checked, onCheckedChange, disabled = false, busy = false, compact = false, className }: ToggleSwitchProps) {
  return <LiquidToggle label={label} value={checked} onChange={onCheckedChange}
    width={compact ? 36 : 48} height={compact ? 22 : 26} disabled={disabled || busy} busy={busy} showLabels={false}
    className={cn('min-h-8 shrink-0', compact ? 'min-w-11 [@media(any-pointer:coarse)]:min-h-11' : 'min-w-14', className)} />
}
