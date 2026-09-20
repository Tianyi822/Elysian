import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import {
  HOST_USER_LOGIN_METHODS,
  HOST_USER_LOGIN_METHOD_LABELS,
  HOST_USER_NAME_MAX_LENGTH,
  HOST_USER_STATUSES,
  HOST_USER_STATUS_LABELS,
  evaluateSshPasswordStrength,
  isValidHostUserName,
} from '@elysian/contracts'
import type { HostUserLoginMethod, HostUserStatus } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { X } from '../../components/icons'
import { useUsersStore } from '../../stores/usersStore'
import { PasswordStrengthBar, PasswordVisibilityButton, passwordInputClass } from './passwordFieldParts'
import { ACTION_CLASS, INPUT_CLASS, SwitchToggle } from './sshCardParts'

/** 登录方式是否包含密码路径：只有这两种才需要（才允许）设置密码。 */
function methodIncludesPassword(method: HostUserLoginMethod): boolean {
  return method === 'password' || method === 'password-or-key'
}

/**
 * 新建 / 修改主机账号的弹窗。
 * 用户名只在新建时可填——Linux 里改名等于新建再迁移，首版不做；主组跟随用户名，与系统默认行为一致。
 * 用户名与重名在界面层先校验一次，adapter 侧用同一判据再挡一次。
 * 登录方式含密码时补密码输入：创建必填初始密码，编辑留空表示不修改当前密码；
 * 客户端强度彩条只是预览，服务端复验是权威（弱密码拒绝，失败走 danger 通知）。
 */
export function HostUserDialog() {
  const gateway = useGateway()
  const dialogUser = useUsersStore((s) => s.dialogUser)
  const users = useUsersStore((s) => s.users)
  const saving = useUsersStore((s) => s.saving)
  const closeDialog = useUsersStore((s) => s.closeDialog)
  const saveUser = useUsersStore((s) => s.saveUser)

  const editing = dialogUser !== 'new' ? dialogUser : undefined
  // 草稿按打开时的账号初始化：弹窗每次打开都是新挂载，因此不必再写一份同步逻辑。
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const [loginMethod, setLoginMethod] = useState<HostUserLoginMethod>(editing?.loginMethod ?? 'key')
  const [status, setStatus] = useState<HostUserStatus>(editing?.status ?? 'active')
  const [isAdmin, setIsAdmin] = useState(editing?.isAdmin ?? false)
  const [note, setNote] = useState(editing?.note ?? '')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined)

  if (dialogUser === undefined) return null

  const userName = editing ? editing.name : name.trim()
  const passwordUsable = methodIncludesPassword(loginMethod)
  const passwordStrength = password ? evaluateSshPasswordStrength(password) : undefined

  const submit = () => {
    if (!editing) {
      if (!isValidHostUserName(userName)) {
        setNameError(
          `用户名只能用小写字母、数字、下划线与连字符，由字母或下划线开头，最长 ${HOST_USER_NAME_MAX_LENGTH} 个字符`,
        )
        return
      }
      if (users.some((user) => user.name === userName)) {
        setNameError(`用户名已存在：${userName}`)
        return
      }
      setNameError(undefined)
    }
    // 创建时登录方式含密码则初始密码必填（与服务端同一句中文错误）；编辑留空表示不修改。
    if (!editing && passwordUsable && !password) {
      setPasswordError('登录方式含密码时必须填写初始密码')
      return
    }
    setPasswordError(undefined)
    void saveUser(gateway, {
      loginMethod,
      status,
      isAdmin,
      note: note.trim() || null,
      // 空串转 undefined：键不随请求发出，服务端据此判定「本次不动密码」。
      ...(passwordUsable && password ? { password } : {}),
      ...(editing ? {} : { name: userName }),
    })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeDialog() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          // 点外部一律不关：填好的配置不该因为一次误点丢掉。Esc 与「取消」「关闭」仍可退出。
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[61] flex max-h-[min(40rem,calc(100vh-3rem))] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl"
        >
          <Dialog.Title className="sr-only">{editing ? `修改账号 ${editing.name}` : '创建用户'}</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
                演示 · 待接入真实执行
              </span>
              <span className="text-sm font-medium text-fg">
                {editing ? `修改账号 ${editing.name}` : '创建用户'}
              </span>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭弹窗"
                className="inline-flex size-7 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
              >
                <X aria-hidden size={15} />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex flex-col gap-4 overflow-y-auto px-4 py-4">
            <div>
              <label htmlFor="host-user-name" className="mb-2 block text-xs font-medium text-fg-muted">
                用户名 <span className="text-danger">*</span>
              </label>
              <input
                id="host-user-name"
                value={userName}
                onChange={(event) => {
                  setName(event.target.value)
                  setNameError(undefined)
                }}
                readOnly={editing !== undefined}
                placeholder="如 wangwu"
                className={`${INPUT_CLASS} w-full ${editing ? 'opacity-60' : ''}`}
              />
              {nameError ? <p className="mt-1 text-xs text-danger">{nameError}</p> : null}
              <p className="mt-2 text-xs text-fg-subtle">
                用户名一旦创建就不再修改；root 账号的登录策略在「SSH 管理」页签里配置。
              </p>
            </div>

            {/* 权限与分组沿用 Linux 的模型：主组跟用户名走，是否提权由管理员组决定。 */}
            <div className="rounded-lg bg-surface-raised px-3 py-3">
              <p className="mb-2 text-xs font-medium text-fg-muted">权限与分组</p>
              <label className="flex cursor-pointer items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-sm text-fg">加入管理员组</span>
                  <span className="mt-0.5 block text-xs text-fg-muted">
                    加入后可用 sudo 提权；不加入只能管理自己的文件
                  </span>
                </span>
                <SwitchToggle
                  label="加入管理员组"
                  checked={isAdmin}
                  onCheckedChange={setIsAdmin}
                />
              </label>
              <p className="mt-2 text-xs text-fg-subtle">
                主组与用户名同名{userName ? `（${userName}）` : ''}，随账号一起创建。
              </p>
            </div>

            <div>
              <p className="mb-1 text-xs font-medium text-fg-muted">登录方式</p>
              <div role="group" aria-label="登录方式" className="grid grid-cols-2 gap-2">
                {HOST_USER_LOGIN_METHODS.map((method) => (
                  <button
                    key={method}
                    type="button"
                    aria-pressed={loginMethod === method}
                    onClick={() => setLoginMethod(method)}
                    className={`rounded-lg border px-2.5 py-2 text-left text-xs transition-colors ${
                      loginMethod === method
                        ? 'border-accent/50 bg-accent/10 font-medium text-accent'
                        : 'border-line text-fg-muted hover:border-fg-subtle hover:text-fg'
                    }`}
                  >
                    {HOST_USER_LOGIN_METHOD_LABELS[method]}
                  </button>
                ))}
              </div>
            </div>

            {passwordUsable ? (
              <div>
                <label
                  htmlFor="host-user-password"
                  className="mb-2 block text-xs font-medium text-fg-muted"
                >
                  {editing ? '新密码' : '初始密码'}
                  {!editing ? <span className="text-danger"> *</span> : null}
                </label>
                <div className="relative">
                  <input
                    id="host-user-password"
                    type={passwordVisible ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value)
                      setPasswordError(undefined)
                    }}
                    placeholder={editing ? '留空表示不修改当前密码' : '请输入密码'}
                    className={passwordInputClass(passwordStrength)}
                  />
                  <PasswordVisibilityButton
                    visible={passwordVisible}
                    onToggle={setPasswordVisible}
                  />
                </div>
                {passwordStrength ? (
                  <div className="mt-2">
                    <PasswordStrengthBar strength={passwordStrength} />
                  </div>
                ) : null}
                {passwordError ? (
                  <p className="mt-1 text-xs text-danger">{passwordError}</p>
                ) : null}
                <p className="mt-2 text-xs text-fg-subtle">
                  强度彩条只是预览，保存时服务端会按同一判据复验
                  {editing ? '；留空则不修改当前密码。' : '。'}
                </p>
              </div>
            ) : null}

            <div>
              <p className="mb-1 text-xs font-medium text-fg-muted">账号状态</p>
              <div role="group" aria-label="账号状态" className="grid grid-cols-2 gap-2">
                {HOST_USER_STATUSES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={status === value}
                    onClick={() => setStatus(value)}
                    className={`rounded-lg border px-2.5 py-2 text-left text-xs transition-colors ${
                      status === value
                        ? 'border-accent/50 bg-accent/10 font-medium text-accent'
                        : 'border-line text-fg-muted hover:border-fg-subtle hover:text-fg'
                    }`}
                  >
                    {HOST_USER_STATUS_LABELS[value]}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-fg-subtle">
                停用后无论登录方式如何都登不上；只跑脚本的账号用「禁止登录」更合适。
              </p>
            </div>

            <div>
              <label htmlFor="host-user-note" className="mb-2 block text-xs font-medium text-fg-muted">
                备注
              </label>
              <input
                id="host-user-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="选填，说明这个账号的用途"
                className={`${INPUT_CLASS} w-full`}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
            <p className="text-xs text-fg-subtle">只改演示数据集。</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => closeDialog()}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
              >
                取消
              </button>
              <button type="button" onClick={submit} disabled={saving} className={ACTION_CLASS}>
                {editing ? '保存修改' : '创建用户'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
