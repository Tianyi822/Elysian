import { LiquidToggle } from './easyui/LiquidToggle'
import { cn } from './easyui/utils'

export interface ToggleSwitchProps {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  busy?: boolean
  className?: string
}

/** 全局布尔设置开关：展示由 EasyUI 承载，确认、保存与失败回读由原调用方处理。 */
export function ToggleSwitch({ label, checked, onCheckedChange, disabled = false, busy = false, className }: ToggleSwitchProps) {
  return <LiquidToggle label={label} value={checked} onChange={onCheckedChange}
    disabled={disabled || busy} busy={busy} className={cn('shrink-0', className)} />
}
