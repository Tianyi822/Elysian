import type { SshPasswordStrength } from '@elysian/contracts'
import { SSH_PASSWORD_STRENGTH_LABELS } from '@elysian/contracts'
import { FORM_CONTROL_HEIGHT_CLASS } from '../../components/formControl'
import { Eye, EyeOff } from '../../components/icons'

/*
 * 密码输入域的共享部件：三段红黄绿强度彩条、随强度变色的输入框描边（聚焦态同色接管）
 * 与明暗切换按钮。SSH 管理的 Root 密码与用户管理的账号密码共用同一套，两处不再各写一份。
 * 客户端强度只是预览：权威判定在服务端（弱密码拒绝，失败走既有 danger 通知）。
 */

/** 等级字配色：弱红、中黄、强绿，与彩条逐段点亮的颜色一一对应。 */
export const STRENGTH_CLASSES: Record<SshPasswordStrength, string> = {
  weak: 'text-danger',
  medium: 'text-warning',
  strong: 'text-success',
}

/** 输入框描边随强度变色：聚焦态由强度色接管（同色描边加深 + 同色光环），替换浏览器默认蓝色聚焦。 */
export const STRENGTH_BORDER: Record<SshPasswordStrength, string> = {
  weak: 'border-danger focus:border-danger focus:outline-none focus:ring-2 focus:ring-danger/40',
  medium: 'border-warning focus:border-warning focus:outline-none focus:ring-2 focus:ring-warning/40',
  strong: 'border-success focus:border-success focus:outline-none focus:ring-2 focus:ring-success/40',
}

export const STRENGTH_LEVEL: Record<SshPasswordStrength, number> = { weak: 1, medium: 2, strong: 3 }

const STRENGTH_SEGMENTS = ['bg-danger', 'bg-warning', 'bg-success'] as const

/**
 * 密码输入框基础类：不含边框色——边框色由强度档位决定（无输入回到默认边框），
 * 因此这里绝不并上含 border-line 的通用输入类，避免两个边框色类在 CSS 里赌生成顺序。
 */
const PASSWORD_INPUT_BASE_CLASS =
  `${FORM_CONTROL_HEIGHT_CLASS} w-full rounded-lg border bg-surface-raised px-2.5 pr-9 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle`

/** 完整的密码输入框类名：有输入取当前强度的描边（含聚焦接管），空输入回到默认边框与默认聚焦。 */
export function passwordInputClass(strength: SshPasswordStrength | undefined): string {
  return `${PASSWORD_INPUT_BASE_CLASS} ${strength ? STRENGTH_BORDER[strength] : 'border-control-line'}`
}

/** 三段红黄绿强度彩条 + 条旁等级字：role=meter，读屏与断言都按等级名取值。 */
export function PasswordStrengthBar({ strength }: { strength: SshPasswordStrength }) {
  return (
    <div className="flex items-center gap-2">
      <div
        role="meter"
        aria-label={`密码强度：${SSH_PASSWORD_STRENGTH_LABELS[strength]}`}
        aria-valuenow={STRENGTH_LEVEL[strength]}
        aria-valuemin={1}
        aria-valuemax={3}
        aria-valuetext={SSH_PASSWORD_STRENGTH_LABELS[strength]}
        className="flex h-1.5 flex-1 gap-1"
      >
        {STRENGTH_SEGMENTS.map((segmentClass, index) => (
          <span
            key={segmentClass}
            className={`h-full flex-1 rounded-full ${
              index < STRENGTH_LEVEL[strength] ? segmentClass : 'bg-line'
            }`}
          />
        ))}
      </div>
      <span className={`text-xs ${STRENGTH_CLASSES[strength]}`}>
        {SSH_PASSWORD_STRENGTH_LABELS[strength]}
      </span>
    </div>
  )
}

/** 明暗切换按钮：图标表达当前状态（掩码闭眼、明文睁眼）；按钮名与 tooltip 保持动作语义。 */
export function PasswordVisibilityButton({
  visible,
  onToggle,
}: {
  visible: boolean
  onToggle: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!visible)}
      aria-label={visible ? '隐藏密码' : '显示密码'}
      title={visible ? '隐藏密码' : '显示密码'}
      className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
    >
      {visible ? <Eye aria-hidden size={14} /> : <EyeOff aria-hidden size={14} />}
    </button>
  )
}
