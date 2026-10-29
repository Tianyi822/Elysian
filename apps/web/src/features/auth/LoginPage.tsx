import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { PasswordVisibilityButton } from '../security/passwordFieldParts'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { Info, TriangleAlert } from '../../components/icons'
import { useSessionStore } from '../../stores/sessionStore'
import { useMessageStore } from '../../stores/messageStore'

/*
 * 登录页（/login，顶层平级路由，不进 AppShell、不包 RequireArea）。
 * 真实会话（Docker 运行时）经 /api/auth/login 登录；服务端中文错误（如「用户名或密码错误」）
 * 在登录表单内显示，不区分用户名错还是密码错，与服务端一致。
 * 会话 store 的一次性提示（如改密成功的「需用新密码重新登录」）在表单内展示，登录成功由 store 清除。
 * 演示模式（本地无后端）不强制登录：访问 /login 直接回仪表盘。
 * 回跳由服务端裁决（GET /api/auth/session?returnTo=），本组件只执行 assign，不自行判定地址可否使用。
 * 裁决须绑回它裁决的那次请求：store 里的 returnToFor 与当前 URL 的 returnTo 不一致即当作尚未裁决——
 * 重探、期间不跳转也不显示裁决派生提示，warm store 下换地址进来或空手进来都不会沿用上一条陈旧裁决。
 * 带 returnTo 时探测在途与回跳在途都只渲染过渡态，绝不闪现登录表单；不带 returnTo 首帧仍是表单。
 * 探测请求本身失败（面板不可达、响应无效）落 error：带与不带 returnTo 一律渲染错误态与重试，
 * 不退回表单假装面板健康——同一故障一种呈现，与 RequireSession 的既有做法一致。
 */

/** 登录表单的两个文本控件同款：内凹一档表达「可写入」，与主按钮的凸起描边成对。 */
const FIELD_CLASS =
  'h-9 w-full rounded-lg border border-control-line bg-surface-raised px-2.5 text-sm text-fg shadow-[inset_0_1px_2px_var(--t-panel-shadow)] transition-colors placeholder:text-fg-subtle hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'

/** 回跳目标校验：须为以单个 / 开头的站内路径；`//` 与 `/\` 是协议相对跳转，一律回落首页。 */function safeRedirectTarget(from: unknown): string {
  if (typeof from !== 'string') return '/'
  if (!from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) return '/'
  return from
}

/**
 * 登录页各态共用的居中外壳：错误态、两个过渡态、表单四处都用它。
 * 一处样式改动只需改这里，不会只落在某一份拷贝上（此前四处手抄同一串 className）。
 * app-canvas 提供色雾与细颗粒背景，卡片与侧栏的毛玻璃才有东西可糊。
 */
function CenteredShell({ children }: { children: ReactNode }) {
  return <main className="app-canvas flex min-h-dvh items-center justify-center p-4 text-fg">{children}</main>
}

/** 卡片内的提示条：图标 + 文字 + 色调三者同时表达，不只靠颜色。 */
function Notice({
  role,
  tone,
  children,
}: {
  role: 'note' | 'status' | 'alert'
  tone: 'muted' | 'warning'
  children: ReactNode
}) {
  const Icon = tone === 'warning' ? TriangleAlert : Info
  return (
    <p
      role={role}
      className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs leading-5 ${
        tone === 'warning' ? 'border-warning/35 bg-warning/10 text-warning' : 'border-panel-line bg-surface/55 text-fg-muted'
      }`}
    >
      <Icon aria-hidden size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  )
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
  const returnToFor = useSessionStore((state) => state.returnToFor)
  const probe = useSessionStore((state) => state.probe)
  const login = useSessionStore((state) => state.login)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const requestedReturnTo = new URLSearchParams(location.search).get('returnTo') ?? undefined

  // /login 不在 RequireSession 之内，这里自己探测一次（补齐 devAccount 回显、已登录判定与服务端回跳裁决）；
  // 演示网关在装配时已同步落位 authed，不会重复探测。
  // 除首屏（phase 仍 unknown）外，warm store 里那条裁决对应的若不是本次 URL 的 returnTo，也重新探测——
  // 否则带着新地址进来会沿用旧地址的裁决（既可能误跳旧工具，也可能对新地址根本不裁决）。
  useEffect(() => {
    const state = useSessionStore.getState()
    if (state.phase === 'unknown' || state.returnToFor !== requestedReturnTo) void probe(gateway, requestedReturnTo)
  }, [probe, gateway, requestedReturnTo])

  const target = safeRedirectTarget((location.state as { from?: unknown } | null)?.from)
  // 裁决只有在「它裁决的就是本次请求」时才可执行：returnToFor 与 URL 上的 returnTo 不一致，
  // 就当尚未裁决（不跳转、不渲染裁决派生的提示）。这里只比请求值串，不做 origin 比对或再裁决。
  const verdictIsFresh = returnToFor === requestedReturnTo
  const adjudicated = verdictIsFresh && typeof returnTo === 'string' ? returnTo : null

  // 离开 SPA 的唯一出口：phase 到位且本次裁决可用时把浏览器送回来源应用。只在 effect 里 assign 一次，
  // 提交路径不重复调用——phase 变化自然走到这里。
  useEffect(() => {
    if (phase === 'authed' && adjudicated !== null) window.location.assign(adjudicated)
  }, [phase, adjudicated])

  // 探测请求本身失败（面板不可达 / 响应无效）：错误态加重试，与 RequireSession 同一条呈现。
  // 带与不带 returnTo 都一样——同一故障不该因怎么到达而分叉，红线要求的四态也不以来源为条件。
  // 排在「裁决未就绪」帧之前：失败时 returnToFor 不会更新到本次请求，若先判未就绪会卡在无限加载。
  // 重试沿用同一个 returnTo 参数，恢复后照常走下面的分支。
  if (phase === 'error') {
    return (
      <CenteredShell>
        <ErrorState
          notify={false}
          title="登录状态检查失败"
          description="无法连接面板服务，请确认服务已启动。"
          onRetry={() => void probe(gateway, requestedReturnTo)}
        />
      </CenteredShell>
    )
  }

  // 带 returnTo 且本次裁决尚未落地（首屏在途，或 warm store 裁决对应的是别的地址、正在重探）一律渲染过渡态：
  // 真实会话下 status 要等一次 /api/auth/session 往返，从来源应用跳进来的已登录用户若先看到表单或旧裁决，
  // 就是规约禁止的闪屏与误跳。不带 returnTo 时不加这一帧，首帧行为与改动前逐字相同。
  if (requestedReturnTo !== undefined && !verdictIsFresh) {
    return (
      <CenteredShell>
        <LoadingState label="正在检查登录状态…" />
      </CenteredShell>
    )
  }

  // 已登录且回跳可用：只呈现过渡态，不闪现表单。
  if (phase === 'authed' && adjudicated !== null) {
    return (
      <CenteredShell>
        <LoadingState label="正在返回刚才的应用…" />
      </CenteredShell>
    )
  }

  // 已登录（探测为 authed 或演示模式）访问 /login：按回跳目标送回，无来源则首页。
  if (phase === 'authed' || mode === 'demo') {
    return <Navigate to={target} replace />
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      await login(gateway, username, password)
      useMessageStore.getState().notify({ tone: 'success', message: '已登录 Elysian' })
      // 只有「没有可用的服务端裁决」才走站内导航：有裁决时 phase 变 authed 后由上面的 effect 离开 SPA。
      // 两条路径必须互斥，否则站内 navigate 与外站 assign 抢同一次跳转，用户会被先送回面板首页。
      if (adjudicated === null) {
        navigate(target, { replace: true })
      }
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : '登录失败')
      setSubmitting(false)
    }
  }

  return (
    <CenteredShell>
      <section className="w-full max-w-sm panel-surface p-6 sm:p-7">
        <div className="flex items-center gap-3">
          {/* 品牌字标与标题同行：卡片开场一行认得出是谁。 */}
          <span
            aria-hidden
            className="grid size-10 shrink-0 place-items-center rounded-xl border border-panel-line bg-nav-selected text-base font-semibold text-accent-fg shadow-[inset_0_1px_0_var(--t-panel-sheen)]"
          >
            E
          </span>
          <h1 className="min-w-0 text-lg font-semibold tracking-tight">登录 Elysian</h1>
        </div>

        {devAccount ? (
          <Notice role="note" tone="warning">
            开发模式已启用固定账号：dev / dev-elysian（仅开发环境可用，生产打包不含此账号）
          </Notice>
        ) : null}

        {adjudicated !== null ? (
          <Notice role="note" tone="muted">{`登录后将返回 ${new URL(adjudicated).origin}`}</Notice>
        ) : requestedReturnTo !== undefined && returnTo === null ? (
          <Notice role="alert" tone="warning">回跳地址不在允许名单，登录后将留在面板。</Notice>
        ) : null}

        {notice && <Notice role="status" tone="muted">{notice}</Notice>}
        {submitError && <Notice role="alert" tone="warning">{submitError}</Notice>}
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
              className={FIELD_CLASS}
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
                className={`${FIELD_CLASS} pr-9`}
              />
              <PasswordVisibilityButton visible={passwordVisible} onToggle={setPasswordVisible} />
            </div>
          </div>

          {/* 主按钮中性描边，动作写进文字（红线：不靠图标表意、不做强调填充底）。 */}
          <button
            type="submit"
            disabled={submitting}
            className="h-9 w-full rounded-lg border border-control-line bg-surface-raised px-4 text-sm font-medium text-fg shadow-[0_1px_2px_var(--t-panel-shadow),inset_0_1px_0_var(--t-panel-sheen)] transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? '正在登录…' : '登录'}
          </button>
        </form>
      </section>
    </CenteredShell>
  )
}
