import { Eye, EyeOff } from './icons'
import { Button } from './Button'

/** 图标表达当前状态，按钮名与提示表达点击后执行的动作。 */
export function PasswordVisibilityButton({
  visible,
  onToggle,
}: {
  visible: boolean
  onToggle: (next: boolean) => void
}) {
  return (
    <Button unstyled
      type="button"
      onClick={() => onToggle(!visible)}
      aria-label={visible ? '隐藏密码' : '显示密码'}
      title={visible ? '隐藏密码' : '显示密码'}
      className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
    >
      {visible ? <Eye aria-hidden size={14} /> : <EyeOff aria-hidden size={14} />}
    </Button>
  )
}
