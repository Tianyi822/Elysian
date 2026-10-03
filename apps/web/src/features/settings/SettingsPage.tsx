import { PanelMaintenanceSettings } from './PanelMaintenanceSettings'
import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { PasswordVisibilityButton } from '../security/passwordFieldParts'
import { useSessionStore } from '../../stores/sessionStore'

/*
 * 设置页只做一件事：修改面板密码。主题在侧边栏切换，不在这里重复。
 * 表单是一条竖列：标签在输入框正上方，规则紧贴在框下，随输入更新；
 * 「全部会话失效」写在按钮正上方，点下去之前就能读到后果。
 * 页面不渲染自己的 h1：顶栏标题由导航项给出。
 */

/** 改密成功的一次性提示：写进会话 store 由登录页展示，文本与规格逐字一致。 */
const PASSWORD_CHANGE_NOTICE = '密码已修改，请使用新密码重新登录'

/** 与服务端 passwordChange 的最小长度同一口径。 */
const PASSWORD_MIN_LENGTH = 8

const INPUT_CLASS =
  'h-[34px] w-full rounded-lg border border-line bg-surface-raised px-2.5 pr-9 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-warning'

function newPasswordGuidance(value: string): { text: string; warning: boolean } {
  if (value.length === 0) return { text: '至少 8 位', warning: false }
  if (value.length < PASSWORD_MIN_LENGTH) {
    return { text: `还差 ${PASSWORD_MIN_LENGTH - value.length} 位`, warning: true }
  }
  return { text: '已满 8 位', warning: false }
}

function confirmGuidance(next: string, confirm: string): { text: string; warning: boolean } {
  if (confirm.length === 0) return { text: '再输入一次新密码', warning: false }
  if (confirm !== next) return { text: '与新密码不一致', warning: true }
  return { text: '与新密码一致', warning: false }
}

function PasswordField({
  id,
  label,
  autoComplete,
  value,
  onChange,
  disabled,
  hintId,
  hint,
  warning,
}: {
  id: string
  label: string
  autoComplete: 'current-password' | 'new-password'
  value: string
  onChange: (value: string) => void
  disabled: boolean
  hintId?: string
  hint?: string
  warning?: boolean
}) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="mb-3 text-xs font-medium text-fg">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={autoComplete}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-describedby={hintId}
          aria-invalid={warning || undefined}
          className={INPUT_CLASS}
        />
        <PasswordVisibilityButton visible={visible} onToggle={setVisible} />
      </div>
      {hint && hintId ? (
        <p id={hintId} className={`mt-1.5 text-xs leading-5 ${warning ? 'text-warning' : 'text-fg-muted'}`}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function SettingsPage() {
  const gateway = useGateway()
  const setNotice = useSessionStore((state) => state.setNotice)
  const expire = useSessionStore((state) => state.expire)

  const titleId = useId()
  const currentPasswordId = useId()
  const newPasswordId = useId()
  const confirmPasswordId = useId()
  const newPasswordHintId = useId()
  const confirmHintId = useId()

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)

  const nextGuidance = newPasswordGuidance(newPassword)
  const againGuidance = confirmGuidance(newPassword, confirmNewPassword)

  const edit = (setter: (value: string) => void) => (value: string) => {
    setPasswordError(null)
    setter(value)
  }

  const onSubmitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    setPasswordError(null)
    // 与服务端同一校验次序：先一致性，再长度。过了才发请求。
    if (newPassword !== confirmNewPassword) {
      setPasswordError('两次输入的密码不一致')
      return
    }
    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      setPasswordError('密码至少需要 8 位')
      return
    }
    setSubmitting(true)
    try {
      await gateway.session.changePassword({ currentPassword, newPassword, confirmNewPassword })
      // 页面自身不导航：先置一次性提示，再落 anonymous，由 RequireSession 的既有分支
      // 作为唯一导航者把路由带到 /login——双导航竞争会把提示从路由 state 里冲掉。
      setNotice(PASSWORD_CHANGE_NOTICE)
      expire()
    } catch (cause) {
      setPasswordError(cause instanceof Error ? cause.message : '修改密码失败')
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-3xl space-y-5">
    <section
      aria-labelledby={titleId}
      className="rounded-xl border border-line bg-surface p-5"
    >
      <h2 id={titleId} className="text-sm font-medium text-fg">
        修改面板密码
      </h2>
      <form className="mt-5 flex flex-col gap-4" onSubmit={(event) => void onSubmitPassword(event)}>
        <PasswordField
          id={currentPasswordId}
          label="当前密码"
          autoComplete="current-password"
          value={currentPassword}
          onChange={edit(setCurrentPassword)}
          disabled={submitting}
        />
        <PasswordField
          id={newPasswordId}
          label="新密码"
          autoComplete="new-password"
          value={newPassword}
          onChange={edit(setNewPassword)}
          disabled={submitting}
          hintId={newPasswordHintId}
          hint={nextGuidance.text}
          warning={nextGuidance.warning}
        />
        <PasswordField
          id={confirmPasswordId}
          label="确认新密码"
          autoComplete="new-password"
          value={confirmNewPassword}
          onChange={edit(setConfirmNewPassword)}
          disabled={submitting}
          hintId={confirmHintId}
          hint={againGuidance.text}
          warning={againGuidance.warning}
        />
        {passwordError ? (
          <p role="alert" className="rounded-lg border border-danger/40 p-2.5 text-xs text-danger">
            {passwordError}
          </p>
        ) : null}
        <p className="text-xs leading-5 text-fg-muted">
          修改成功后，全部登录会话会立刻失效，需要用新密码重新登录。
        </p>
        <button
          type="submit"
          disabled={submitting}
          className="h-9 rounded-lg border border-line bg-surface-raised px-4 text-sm font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? '正在修改…' : '修改密码'}
        </button>
      </form>
    </section>
    <PanelMaintenanceSettings />
    </div>
  )
}
