import { useEffect, useId, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { CountdownRing } from '../../components/icons'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { usePanelStore } from '../../stores/panelStore'
import { useSessionStore } from '../../stores/sessionStore'
import { PANEL_RELOAD_DELAY_MS } from './panelReload'
import { reloadPanelPage } from './panelNavigation'
import './panelReloadCountdown.css'

/** 不占用页面焦点、不阻挡周围页面；所有执行路径共用一次性重载标记。 */
export function PanelReloadCountdown() {
  const reload = usePanelStore(s => s.reload)
  const phase = useSessionStore(s => s.phase)
  const [now, setNow] = useState(Date.now)
  const auth = useMemo(captureAuthGeneration, [reload?.taskId, reload?.deadline])
  const title = useId(), description = useId()
  useEffect(() => {
    if (!reload || reload.executed || phase !== 'authed') return
    const tick = () => {
      setNow(Date.now())
      if (Date.now() >= reload.deadline && usePanelStore.getState().consumeReload(reload.taskId, auth)) reloadPanelPage()
    }
    tick()
    const timer = setInterval(tick, 250)
    const events = ['focus', 'pageshow', 'online'] as const
    events.forEach(event => window.addEventListener(event, tick))
    document.addEventListener('visibilitychange', tick)
    document.addEventListener('resume', tick)
    return () => {
      clearInterval(timer)
      events.forEach(event => window.removeEventListener(event, tick))
      document.removeEventListener('visibilitychange', tick)
      document.removeEventListener('resume', tick)
    }
  }, [reload?.taskId, reload?.deadline, reload?.executed, phase, auth])
  if (!reload || reload.executed || phase !== 'authed') return null
  const remaining = Math.max(0, reload.deadline - now)
  return createPortal(<div role="dialog" aria-modal="false" aria-labelledby={title} aria-describedby={description} className="fixed left-1/2 top-1/2 z-[80] size-40 -translate-x-1/2 -translate-y-1/2">
    <p role="status" className="sr-only">更新完成，倒计时结束后重新加载当前页面，也可立刻重启。</p>
    <p id={description} className="sr-only">剩余 {Math.ceil(remaining / 1000)} 秒后重新加载当前页面。</p>
    <button type="button" aria-label="立刻重启" aria-describedby={description} data-animation-paused={document.hidden || undefined} className="panel-reload-countdown group relative flex size-40 flex-col items-center justify-center rounded-full border border-line bg-surface-raised text-fg shadow-[0_8px_24px_-12px_var(--t-panel-shadow)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-fg" onClick={() => {
      if (usePanelStore.getState().consumeReload(reload.taskId, auth)) reloadPanelPage()
    }}>
      <CountdownRing progress={Math.min(1, remaining / PANEL_RELOAD_DELAY_MS)} aria-hidden className="pointer-events-none absolute inset-0 size-full" />
      <span id={title} className="text-xs font-medium text-fg-muted">更新完成</span>
      <span className="relative mt-1 flex h-12 items-center justify-center">
        <span aria-hidden className="text-4xl font-medium tabular-nums tracking-tight group-hover:invisible group-focus-visible:invisible">{Math.ceil(remaining / 1000)}</span>
        <span aria-hidden className="invisible absolute whitespace-nowrap text-base font-medium text-accent-fg group-hover:visible group-focus-visible:visible">立刻重启</span>
      </span>
      <span aria-hidden className="mt-1 text-[11px] text-fg-subtle group-hover:invisible group-focus-visible:invisible">秒后重启</span>
    </button>
  </div>, document.body)
}
