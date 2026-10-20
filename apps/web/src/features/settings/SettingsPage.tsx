import { Navigate, useSearchParams } from 'react-router'
import { ExtensionSettingsSection } from './ExtensionSettingsSection'
import { useAgentExtensionsStore } from '../../stores/agentExtensionsStore'
import * as Dialog from '@radix-ui/react-dialog'
import { PanelMaintenanceSettings } from './PanelMaintenanceSettings'
import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { PasswordVisibilityButton } from '../security/passwordFieldParts'
import { CTL_FIELD } from '../../components/formControl'
import { useFeedbackNotification } from '../../components/useFeedbackNotification'
import { useSessionStore } from '../../stores/sessionStore'
import { RequireArea } from '../../app/RequireArea'
import { ModelSettingsSection } from './ModelSettingsSection'
import { SETTINGS_TABS, useSettingsTab, type SettingsTab } from './settingsTabs'

/*
 * 设置页按面板维护、账号安全、模型、MCP 与 Skill 配置分区。主题在侧边栏切换。
 * 表单是一条竖列：标签在输入框正上方，规则紧贴在框下，随输入更新；
 * 密码通过表单校验后确认会话退出，再提交接口。
 * 页面不渲染自己的 h1：顶栏标题由导航项给出。
 */

/** 改密成功的一次性提示：写进会话 store 由登录页展示，文本与规格逐字一致。 */
const PASSWORD_CHANGE_NOTICE = '密码已修改，请使用新密码重新登录'

/** 与服务端 passwordChange 的最小长度同一口径。 */
const PASSWORD_MIN_LENGTH = 8

const INPUT_CLASS =
  `${CTL_FIELD} pr-9 disabled:cursor-not-allowed aria-invalid:border-warning`

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

function AccountSecuritySettings() {
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
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  useFeedbackNotification(passwordError)

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
    setConfirmOpen(true)
  }

  const confirmPasswordChange = async () => {
    if (submitting) return
    setConfirmOpen(false)
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
      className="panel-surface p-5"
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
        <button
          type="submit"
          disabled={submitting}
          className="h-9 rounded-lg border border-control-line bg-surface-raised px-4 text-sm font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? '正在修改…' : '修改密码'}
        </button>
      </form>
    </section>
    <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl">
          <Dialog.Title className="text-sm font-semibold text-fg">确认修改密码</Dialog.Title>
          <Dialog.Description className="mt-2 text-xs leading-5 text-fg-muted">修改后，所有已登录设备都会退出，请用新密码重新登录。</Dialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild><button type="button" className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted">取消</button></Dialog.Close>
            <button type="button" disabled={submitting} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-fg" onClick={() => void confirmPasswordChange()}>确认修改</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    </div>
  )
}

/** 访问过的页签保持挂载：保存表单草稿，维护任务切换页签后继续轮询。 */
export function SettingsPage() {
  const { tab } = useSettingsTab()
  const [params] = useSearchParams()
  useEffect(() => {
    const unsubscribe = useSessionStore.subscribe((state, previous) => {
      if (state.phase !== previous.phase && state.phase !== 'authed') { useAgentExtensionsStore.getState().reset() }
    })
    return () => { unsubscribe(); useAgentExtensionsStore.getState().reset() }
  }, [])
  const [visited, setVisited] = useState<ReadonlySet<SettingsTab>>(() => new Set([tab]))
  useEffect(() => { setVisited((current) => current.has(tab) ? current : new Set([...current, tab])) }, [tab])
  if (params.get('tab') === 'execution' || params.get('tab') === 'grants') return <Navigate to="/agent" replace />
  return <div className="min-w-0">
    {SETTINGS_TABS.map((item) => (visited.has(item.value) || tab === item.value) ? (
      <div key={item.value} className={tab === item.value ? 'block' : 'hidden'}>
        {item.value === 'models' ? <RequireArea area="agent" title="模型配置"><ModelSettingsSection active={tab === 'models'} /></RequireArea> : null}
        {item.value === 'mcp' || item.value === 'skills' ? <RequireArea area="agent" title={item.label}><ExtensionSettingsSection kind={item.value} active={tab === item.value} /></RequireArea> : null}
        {item.value === 'account' ? <AccountSecuritySettings /> : null}
        {item.value === 'maintenance' ? <div className="max-w-3xl space-y-5"><PanelMaintenanceSettings /></div> : null}
      </div>
    ) : null)}
  </div>
}
