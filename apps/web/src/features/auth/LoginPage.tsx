import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { PasswordVisibilityButton } from '../security/passwordFieldParts'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { useSessionStore } from '../../stores/sessionStore'

/*
 * 登录页（/login，顶层平级路由，不进 AppShell、不包 RequireArea）。
 * 真实会话（Docker 运行时）经 /api/auth/login 登录；服务端中文错误（如「用户名或密码错误」）
 * 显示在 role="alert" 的错误框——不区分用户名错还是密码错，与服务端一致。
 * 会话 store 的一次性提示（如改密成功的「需用新密码重新登录」）在表单上方以 role="status" 展示，
 * 与开发账号提示同位、互不排斥；登录成功由 store 清除。
 * 演示模式（本地无后端）不强制登录：访问 /login 直接回仪表盘。
 * 回跳由服务端裁决（GET /api/auth/session?returnTo=），本组件只执行 assign，不自行判定地址可否使用。
 * 带 returnTo 时探测在途与回跳在途都只渲染过渡态，绝不闪现登录表单；不带 returnTo 首帧仍是表单。
 * 探测请求本身失败（面板不可达、响应无效）落 error：带与不带 returnTo 一律渲染错误态与重试，
 * 不退回表单假装面板健康——同一故障一种呈现，与 RequireSession 的既有做法一致。
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
  const returnTo = useSessionStore((state) => state.returnTo)
  const probe = useSessionStore((state) => state.probe)
  const login = useSessionStore((state) => state.login)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const requestedReturnTo = new URLSearchParams(location.search).get('returnTo') ?? undefined

  // /login 不在 RequireSession 之内，这里自己探测一次（补齐 devAccount 回显、已登录判定与服务端回跳裁决）；
  // 演示网关在装配时已同步落位 authed，不会重复探测。
  useEffect(() => {
    if (useSessionStore.getState().phase === 'unknown') void probe(gateway, requestedReturnTo)
  }, [probe, gateway, requestedReturnTo])

  const target = safeRedirectTarget((location.state as { from?: unknown } | null)?.from)
  const adjudicated = typeof returnTo === 'string' ? returnTo : null

  // 离开 SPA 的唯一出口：phase 到位且裁决可用时把浏览器送回来源应用。只在 effect 里 assign 一次，
  // 提交路径不重复调用——phase 变化自然走到这里。
  useEffect(() => {
    if (phase === 'authed' && adjudicated !== null) window.location.assign(adjudicated)
  }, [phase, adjudicated])

  // 带 returnTo 时探测未落地一律渲染过渡态：真实会话下 status 要等一次 /api/auth/session 往返，
  // 从来源应用跳进来的已登录用户若先看到表单，就是规约禁止的闪屏。
  // 不带 returnTo 时不加这一帧，首帧行为与改动前逐字相同。
  if (phase === 'unknown' && requestedReturnTo !== undefined) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg p-4 text-fg">
        <LoadingState label="正在检查登录状态…" />
      </main>
    )
  }

  // 探测请求本身失败（面板不可达 / 响应无效）：错误态加重试，与 RequireSession 同一条呈现。
  // 带与不带 returnTo 都一样——同一故障不该因怎么到达而分叉，红线要求的四态也不以来源为条件。
  // 重试沿用同一个 returnTo 参数，恢复后照常走下面的分支。
  if (phase === 'error') {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg p-4 text-fg">
        <ErrorState
          title="登录状态检查失败"
          description="无法连接面板服务，请确认服务已启动。"
          onRetry={() => void probe(gateway, requestedReturnTo)}
        />
      </main>
    )
  }

  // 已登录且回跳可用：只呈现过渡态，不闪现表单。
  if (phase === 'authed' && adjudicated !== null) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg p-4 text-fg">
        <LoadingState label="正在返回刚才的应用…" />
      </main>
    )
  }

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
      // 只有「没有可用的服务端裁决」才走站内导航：有裁决时 phase 变 authed 后由上面的 effect 离开 SPA。
      // 两条路径必须互斥，否则站内 navigate 与外站 assign 抢同一次跳转，用户会被先送回面板首页。
      if (adjudicated === null) {
        navigate(target, { replace: true })
      }
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

        {adjudicated !== null ? (
          <p role="note" className="mt-4 rounded-lg border border-line p-2.5 text-xs text-fg-muted">
            {`登录后将返回 ${new URL(adjudicated).origin}`}
          </p>
        ) : requestedReturnTo !== undefined && returnTo === null ? (
          <p role="alert" className="mt-4 rounded-lg border border-warning/40 p-2.5 text-xs text-warning">
            回跳地址不在允许名单，登录后将留在面板。
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
