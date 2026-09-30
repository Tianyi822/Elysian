import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { PasswordVisibilityButton } from '../security/passwordFieldParts'
import { useSessionStore } from '../../stores/sessionStore'

/*
 * 登录页（/login，顶层平级路由，不进 AppShell、不包 RequireArea）。
 * 真实会话（Docker 运行时）经 /api/auth/login 登录；服务端中文错误（如「用户名或密码错误」）
 * 显示在 role="alert" 的错误框——不区分用户名错还是密码错，与服务端一致。
 * 会话 store 的一次性提示（如改密成功的「需用新密码重新登录」）在表单上方以 role="status" 展示，
 * 与开发账号提示同位、互不排斥；登录成功由 store 清除。
 * 演示模式（本地无后端）不强制登录：访问 /login 直接回仪表盘。
 */

/** 回跳目标校验：须为以单个 / 开头的站内路径；`//` 与 `/\` 是协议相对跳转，一律回落首页。 */
function safeRedirectTarget(from: unknown): string {
  if (typeof from !== 'string') return '/'
  if (!from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) return '/'
  return from
}

export function LoginPage() {
  const gateway = useGateway()
  const location = useLocation()
  const navigate = useNavigate()
  const phase = useSessionStore((state) => state.phase)
  const mode = useSessionStore((state) => state.mode)
  const devAccount = useSessionStore((state) => state.devAccount)
  const notice = useSessionStore((state) => state.notice)
  const probe = useSessionStore((state) => state.probe)
  const login = useSessionStore((state) => state.login)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // /login 不在 RequireSession 之内，这里自己探测一次（补齐 devAccount 回显与已登录判定）；
  // 演示网关在装配时已同步落位 authed，不会重复探测。
  useEffect(() => {
    if (useSessionStore.getState().phase === 'unknown') void probe(gateway)
  }, [probe, gateway])

  const target = safeRedirectTarget((location.state as { from?: unknown } | null)?.from)

  // 已登录（探测为 authed 或演示模式）访问 /login：按回跳目标送回，无来源则首页。
  if (phase === 'authed' || mode === 'demo') {
    return <Navigate to={target} replace />
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      await login(gateway, username, password)
      // phase 已置 authed，上方渲染分支随即按回跳目标导航。
      navigate(target, { replace: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败')
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg p-4 text-fg">
      <section className="w-full max-w-sm rounded-xl border border-line bg-surface p-6">
        <h1 className="text-lg font-semibold tracking-tight">登录 Elysian</h1>
        <p className="mt-1 text-xs text-fg-muted">运维工作台需要登录后使用。</p>

        {devAccount ? (
          <p className="mt-4 rounded-lg border border-warning/40 p-2.5 text-xs text-warning" role="note">
            开发模式已启用固定账号：dev / dev-elysian（仅开发环境可用，生产打包不含此账号）
          </p>
        ) : null}

        {notice ? (
          <p role="status" className="mt-4 rounded-lg border border-line p-2.5 text-xs text-fg-muted">
            {notice}
          </p>
        ) : null}

        <form className="mt-5 flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-username" className="text-xs font-medium text-fg-muted">
              用户名
            </label>
            <input
              id="login-username"
              name="username"
              type="text"
              autoComplete="username"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={submitting}
              className="h-[34px] w-full rounded-lg border border-line bg-surface-raised px-2.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-password" className="text-xs font-medium text-fg-muted">
              密码
            </label>
            <div className="relative">
              <input
                id="login-password"
                name="password"
                type={passwordVisible ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={submitting}
                className="h-[34px] w-full rounded-lg border border-line bg-surface-raised px-2.5 pr-9 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
              />
              <PasswordVisibilityButton visible={passwordVisible} onToggle={setPasswordVisible} />
            </div>
          </div>

          {error ? (
            <p role="alert" className="rounded-lg border border-danger/40 p-2.5 text-xs text-danger">
              {error}
            </p>
          ) : null}

          {/* 主按钮中性描边，动作写进文字（红线：不靠图标表意、不做强调填充底）。 */}
          <button
            type="submit"
            disabled={submitting}
            className="h-9 rounded-lg border border-line bg-surface-raised px-4 text-sm font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? '正在登录…' : '登录'}
          </button>
        </form>
      </section>
    </main>
  )
}
