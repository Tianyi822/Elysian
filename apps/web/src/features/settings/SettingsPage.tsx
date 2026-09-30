import { useEffect, useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { useTheme } from '../../app/theme/ThemeProvider'
import { IconButton } from '../../components/IconButton'
import { StatusTag } from '../../components/StatusTag'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { formatDateTime } from '../../components/format'
import { RefreshCw } from '../../components/icons'
import { useNotificationStore } from '../../stores/notificationStore'
import { useSessionStore } from '../../stores/sessionStore'
import type { SessionListRow } from '../../contracts/adapters'

/**
 * 设置页：账号与安全（修改面板密码、活跃会话）、外观（主题三选一）、面板信息（只读事实）三节。
 * 行式布局取「标签 | 控件 | 说明」的格子气质，窄屏时说明换行到控件下方、不横向溢出。
 * 页面不渲染自己的 h1：顶栏标题由导航项前缀匹配给出。
 */

/** 改密成功的一次性提示：写进会话 store 由登录页展示，文本与规格逐字一致。 */
const PASSWORD_CHANGE_NOTICE = '密码已修改，请使用新密码重新登录'

/** 行式布局：标签 | 控件 | 说明；窄屏退化为纵向堆叠。 */
function SettingRow({
  label,
  htmlFor,
  labelId,
  note,
  children,
}: {
  label: string
  /** 传入时标签渲染为 label 元素并与控件关联。 */
  htmlFor?: string
  /** 控件是一组（如主题三选一）时，用 labelId 让组引用本行标签。 */
  labelId?: string
  note?: string
  children: ReactNode
}) {
  const labelNode = htmlFor ? (
    <label htmlFor={htmlFor} className="text-xs font-medium text-fg-muted">
      {label}
    </label>
  ) : (
    <span id={labelId} className="text-xs font-medium text-fg-muted">
      {label}
    </span>
  )
  return (
    <div className="flex flex-col gap-1.5 sm:grid sm:grid-cols-[7rem_minmax(0,22rem)_minmax(0,1fr)] sm:items-center sm:gap-x-4">
      {labelNode}
      {children}
      {note ? <p className="text-xs leading-5 text-fg-muted">{note}</p> : null}
    </div>
  )
}

/** 动作行：没有标签，桌面网格里留空槽对齐，窄屏下不占位。 */
function ActionRow({ note, children }: { note?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 sm:grid sm:grid-cols-[7rem_minmax(0,22rem)_minmax(0,1fr)] sm:items-center sm:gap-x-4">
      <span aria-hidden className="hidden sm:block" />
      {children}
      {note ? <p className="text-xs leading-5 text-fg-muted">{note}</p> : null}
    </div>
  )
}

const INPUT_CLASS =
  'h-[34px] w-full rounded-lg border border-line bg-surface-raised px-2.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'

const PRIMARY_ACTION_CLASS =
  'h-9 rounded-lg border border-line bg-surface-raised px-4 text-sm font-medium text-fg transition-colors hover:border-fg-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'

const SECONDARY_ACTION_CLASS =
  'inline-flex h-[34px] shrink-0 items-center rounded-lg border border-line bg-surface-raised px-3 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'

type ThemeChoice = 'light' | 'dark' | 'system'

const THEME_OPTIONS: readonly { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

type SessionListPhase = 'loading' | 'ready' | 'error'

export function SettingsPage() {
  const gateway = useGateway()
  const mode = useSessionStore((state) => state.mode)
  const setNotice = useSessionStore((state) => state.setNotice)
  const expire = useSessionStore((state) => state.expire)
  const { theme, followsSystem, setTheme, followSystemTheme } = useTheme()

  const accountTitleId = useId()
  const appearanceTitleId = useId()
  const panelInfoTitleId = useId()
  const currentPasswordId = useId()
  const newPasswordId = useId()
  const confirmPasswordId = useId()
  const themeLabelId = useId()

  // ── 修改面板密码 ────────────────────────────────────────────────
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)

  const onSubmitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    setPasswordError(null)
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

  // ── 活跃会话 ────────────────────────────────────────────────────
  // 行与相位分开存：刷新时保留上一次的行让表格不闪空，首载才显示加载态。
  const [listPhase, setListPhase] = useState<SessionListPhase>('loading')
  const [rows, setRows] = useState<readonly SessionListRow[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [loggingOutOthers, setLoggingOutOthers] = useState(false)

  useEffect(() => {
    let cancelled = false
    setListPhase('loading')
    void gateway.session.listSessions().then(
      (next) => {
        if (cancelled) return
        setRows(next)
        setListError(null)
        setListPhase('ready')
      },
      (cause) => {
        if (cancelled) return
        setListError(cause instanceof Error ? cause.message : '会话列表获取失败')
        setListPhase('error')
      },
    )
    return () => {
      cancelled = true
    }
  }, [gateway, reloadToken])

  const refresh = () => setReloadToken((token) => token + 1)

  const hasOtherSessions = rows.some((row) => !row.current)

  const confirmLogoutOthers = async () => {
    if (loggingOutOthers) return
    setLoggingOutOthers(true)
    try {
      await gateway.session.logoutOtherSessions()
      setConfirmOpen(false)
      // 操作后的可见状态变化就是列表只剩当前会话行，不再发额外通知。
      refresh()
    } catch (cause) {
      setConfirmOpen(false)
      useNotificationStore.getState().notify({
        tone: 'danger',
        message: cause instanceof Error ? cause.message : '退出其他会话失败',
      })
    } finally {
      setLoggingOutOthers(false)
    }
  }

  // ── 主题 ────────────────────────────────────────────────────────
  const effectiveChoice: ThemeChoice = followsSystem ? 'system' : theme

  const onThemeChange = (choice: ThemeChoice) => {
    if (choice === 'system') {
      followSystemTheme()
      return
    }
    setTheme(choice)
  }

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-labelledby={accountTitleId}
        className="rounded-xl border border-line bg-surface p-4 sm:p-5"
      >
        <h2 id={accountTitleId} className="text-sm font-medium text-fg">
          账号与安全
        </h2>
        <div className="mt-4 flex flex-col gap-6">
          <form className="flex flex-col gap-3" onSubmit={(event) => void onSubmitPassword(event)}>
            <h3 className="text-xs font-medium text-fg-muted">修改面板密码</h3>
            <SettingRow label="当前密码" htmlFor={currentPasswordId}>
              <input
                id={currentPasswordId}
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                disabled={submitting}
                className={INPUT_CLASS}
              />
            </SettingRow>
            <SettingRow label="新密码" htmlFor={newPasswordId} note="至少 8 位">
              <input
                id={newPasswordId}
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={submitting}
                className={INPUT_CLASS}
              />
            </SettingRow>
            <SettingRow label="确认新密码" htmlFor={confirmPasswordId}>
              <input
                id={confirmPasswordId}
                name="confirmNewPassword"
                type="password"
                autoComplete="new-password"
                required
                value={confirmNewPassword}
                onChange={(event) => setConfirmNewPassword(event.target.value)}
                disabled={submitting}
                className={INPUT_CLASS}
              />
            </SettingRow>
            <ActionRow note="修改成功后全部登录会话失效，需用新密码重新登录">
              <button type="submit" disabled={submitting} className={PRIMARY_ACTION_CLASS}>
                {submitting ? '正在修改…' : '修改密码'}
              </button>
            </ActionRow>
            {passwordError ? (
              <p role="alert" className="rounded-lg border border-danger/40 p-2.5 text-xs text-danger">
                {passwordError}
              </p>
            ) : null}
          </form>

          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-medium text-fg-muted">活跃会话</h3>
              {/* 演示模式下列表来自内存种子，明示出来不把演示会话呈现为真实事实。 */}
              {mode === 'demo' ? (
                <span role="status" className="text-sm text-fg-muted">
                  演示数据
                </span>
              ) : null}
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmOpen(true)}
                  disabled={!hasOtherSessions}
                  className={SECONDARY_ACTION_CLASS}
                >
                  退出其他会话
                </button>
                <IconButton label="刷新会话列表" onPress={refresh}>
                  <RefreshCw
                    aria-hidden
                    size={14}
                    className={listPhase === 'loading' ? 'animate-spin' : ''}
                  />
                </IconButton>
              </div>
            </div>

            <div className="mt-3">
              {listPhase === 'error' ? (
                <ErrorState title="会话列表加载失败" description={listError ?? undefined} onRetry={refresh} />
              ) : listPhase === 'loading' && rows.length === 0 ? (
                <LoadingState label="正在加载活跃会话…" />
              ) : rows.length === 0 ? (
                // 服务端保证至少含当前会话一行，空态是防御性分支，正常不可达。
                <EmptyState title="暂无活跃会话" />
              ) : (
                <div
                  role="region"
                  aria-label="活跃会话表"
                  className="overflow-hidden rounded-lg border border-line"
                >
                  <table className="w-full table-fixed border-separate border-spacing-0 text-left text-sm">
                    <colgroup>
                      <col className="w-[38%]" />
                      <col className="w-[38%]" />
                      <col className="w-[24%]" />
                    </colgroup>
                    <thead>
                      <tr>
                        {['创建时间', '最近活跃', '标记'].map((label) => (
                          <th
                            key={label}
                            scope="col"
                            className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted"
                          >
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, index) => (
                        <tr
                          key={`${row.createdAt}-${row.lastUsedAt}-${index}`}
                          className="transition-colors hover:bg-surface-raised"
                        >
                          <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">
                            {formatDateTime(row.createdAt)}
                          </td>
                          <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">
                            {formatDateTime(row.lastUsedAt)}
                          </td>
                          <td className="border-b border-line px-3 py-2.5">
                            {row.current ? <StatusTag label="当前会话" tone="success" /> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section
        aria-labelledby={appearanceTitleId}
        className="rounded-xl border border-line bg-surface p-4 sm:p-5"
      >
        <h2 id={appearanceTitleId} className="text-sm font-medium text-fg">
          外观
        </h2>
        <div className="mt-4">
          <SettingRow label="主题" labelId={themeLabelId} note="与侧边栏主题行共用同一份界面偏好">
            <div
              role="radiogroup"
              aria-labelledby={themeLabelId}
              className="inline-flex w-fit overflow-hidden rounded-lg border border-line"
            >
              {THEME_OPTIONS.map((option, index) => (
                <label
                  key={option.value}
                  className={`flex h-[34px] cursor-pointer items-center gap-1.5 px-3 text-sm transition-colors ${
                    index > 0 ? 'border-l border-line' : ''
                  } ${
                    effectiveChoice === option.value
                      ? 'bg-surface-raised font-medium text-fg'
                      : 'text-fg-muted hover:bg-surface-raised/60 hover:text-fg'
                  }`}
                >
                  {/* 原生 radio：方向键原生可达；全局基线关掉了输入类焦点环，这里显式补回。 */}
                  <input
                    type="radio"
                    name="settings-theme"
                    value={option.value}
                    checked={effectiveChoice === option.value}
                    onChange={() => onThemeChange(option.value)}
                    className="cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </SettingRow>
        </div>
      </section>

      <section
        aria-labelledby={panelInfoTitleId}
        className="rounded-xl border border-line bg-surface p-4 sm:p-5"
      >
        <h2 id={panelInfoTitleId} className="text-sm font-medium text-fg">
          面板信息
        </h2>
        <div className="mt-4 flex flex-col gap-3">
          <SettingRow label="当前账号" note="单用户面板的固定账号">
            <span className="text-sm text-fg">admin</span>
          </SettingRow>
          <SettingRow
            label="访问端口"
            note="compose 形态发布 127.0.0.1:48100:48100，仅宿主回环可达；端口由部署配置固定，运行时不可修改"
          >
            <span className="text-sm tabular-nums text-fg">48100</span>
          </SettingRow>
          <SettingRow
            label="数据目录"
            note="面板自管数据收口：凭据在 config/、会话在 state/、指标在 data/；容器内 /root/.Elysian 是指向持久卷 /var/lib/elysian 的符号链接"
          >
            <span className="text-sm text-fg">~/.Elysian</span>
          </SettingRow>
        </div>
      </section>

      <Dialog.Root
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface-raised p-4 shadow-xl"
          >
            <Dialog.Title className="text-sm font-semibold">确认退出其他会话？</Dialog.Title>
            <p className="mt-1.5 text-xs text-fg-muted">
              将退出其他浏览器或窗口里的全部会话，当前会话不受影响。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                disabled={loggingOutOthers}
                onClick={() => void confirmLogoutOthers()}
                className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loggingOutOthers ? '正在退出…' : '确认退出'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
