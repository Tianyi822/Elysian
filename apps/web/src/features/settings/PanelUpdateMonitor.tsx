import { useEffect } from 'react'
import { panelTaskIsActive } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { PanelNetworkError, probeSameOriginHealth } from '../../adapters/http/panelHttpAdapter'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { usePanelStore } from '../../stores/panelStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useMessageStore } from '../../stores/messageStore'
import { panelAddress } from './panelAddress'
import { openPanelAddress } from './panelNavigation'
import { readPanelPending } from './panelPending'
import { frontendCommit, readPanelReload } from './panelReload'
import { PanelReloadCountdown } from './PanelReloadCountdown'

const DISCONNECT_BUDGET_MS = 120_000

/** 登录后唯一的维护监控。业务路由和标签页可见性均不控制其生命周期。 */
export function PanelUpdateMonitor() {
  const gateway = useGateway()
  const phase = useSessionStore(s => s.phase)
  useEffect(() => {
    if (phase !== 'authed') return
    const auth = captureAuthGeneration(), abort = new AbortController()
    let stopped = false, busy = false, initialized = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let disconnectedAt: number | undefined, recovering = false
    let discoverAt = 0
    let refreshedTerminal: string | undefined
    const current = () => !stopped && !abort.signal.aborted && auth === captureAuthGeneration()
    const store = () => usePanelStore.getState()
    const schedule = (delay: number) => {
      if (!current()) return
      clearTimeout(timer)
      timer = setTimeout(() => void tick(), delay)
    }
    const wake = () => {
      if (!current()) return
      if (!busy) schedule(0)
    }
    const tick = async () => {
      if (!current() || busy) return
      busy = true
      let next = 15_000
      let loaded = false, failed = false
      try {
        if (!initialized) {
          initialized = true
          if (!store().pending) store().setPending(readPanelPending())
          await store().load(gateway, false, abort.signal)
          discoverAt = Date.now() + 15_000
          loaded = true
          if (!current()) return
        }
        const pending = store().pending
        if (pending) {
          next = 2000
          try {
            const found = await gateway.panel.taskByRequest(pending.requestId, abort.signal)
            if (!current()) return
            if (found && store().acceptPending(found, pending.requestId)) {
              useMessageStore.getState().notify({ tone: 'info', message: '面板维护任务已提交' })
            } else if (store().pending?.requestId === pending.requestId) usePanelStore.setState({ progressError: null })
          } catch (cause) {
            if (current() && store().pending?.requestId === pending.requestId) usePanelStore.setState({ progressError: cause instanceof Error ? cause.message : '查询维护提交结果失败' })
          }
        }
        if (recovering) {
          next = 5000
          const health = await probeSameOriginHealth(abort.signal)
          if (!current()) return
          if (!health) return
          recovering = false; disconnectedAt = undefined
          usePanelStore.setState({ connectionError: null })
        }
        const task = store().task
        const polling = task && (panelTaskIsActive(task) || task.cliRegistration?.status === 'pending' || store().hasMore)
        if (polling) {
          next = 2000
          const nextUrl = new URL(panelAddress(task.newPorts.frontendPort))
          if ((panelTaskIsActive(task) || task.cliRegistration?.status === 'pending') && nextUrl.origin !== window.location.origin) {
            const probeAbort = new AbortController()
            const cancel = () => probeAbort.abort()
            abort.signal.addEventListener('abort', cancel, { once: true })
            const timeout = setTimeout(cancel, 3000)
            let ready = false
            try { ready = await gateway.panel.ready(nextUrl.origin, task.id, probeAbort.signal) } catch { /* 维护期间新入口可能暂不可达。 */ }
            finally { clearTimeout(timeout); abort.signal.removeEventListener('abort', cancel) }
            if (!current()) return
            if (ready) { nextUrl.searchParams.set('maintenanceTask', task.id); openPanelAddress(nextUrl.toString()); return }
          }
          const report = await store().poll(gateway, abort.signal)
          if (!current()) return
          if (report?.hasMore) next = 0
          disconnectedAt = undefined
          usePanelStore.setState({ connectionError: null, progressError: null })
        } else if (!pending && !loaded && Date.now() >= discoverAt) {
          await store().load(gateway, false, abort.signal)
          discoverAt = Date.now() + 15_000
          if (!current()) return
        }
        const finished = store().task
        if (!finished || panelTaskIsActive(finished)) return
        if (finished.kind === 'update' && finished.state === 'succeeded') {
          const saved = store().reload ?? readPanelReload()
          const built = frontendCommit()
          const eligible = store().trackedTaskId === finished.id || saved?.taskId === finished.id || (built !== '' && built !== finished.targetCommit)
          if (built !== '' && built === finished.targetCommit) {
            usePanelStore.setState({ verifiedUpdate: finished.id, verificationError: null, needsManualReload: false })
          } else if (eligible && store().verifiedUpdate !== finished.id && !(saved?.taskId === finished.id && saved.executed)) {
            next = Math.min(next, 5000)
            const health = await probeSameOriginHealth(abort.signal)
            if (!current() || store().task?.id !== finished.id) return
            if (health?.commit && health.commit === finished.targetCommit) store().requestReload(finished)
            else usePanelStore.setState({ needsManualReload: true, verificationError: health?.commit
              ? `面板已恢复，但运行版本 ${health.commit.slice(0, 7)} 与目标提交不一致，未自动刷新页面；请查看任务日志或在服务器核实。`
              : '面板已恢复，但暂无法确认运行版本，未自动刷新页面；可手动重新加载后查看当前版本。' })
          }
        } else if (store().trackedTaskId === finished.id && refreshedTerminal !== finished.id) {
          refreshedTerminal = finished.id
          await store().load(gateway, true, abort.signal)
        }
      } catch (cause) {
        failed = true
        if (!current()) return
        next = 2000
        if (cause instanceof PanelNetworkError) {
          disconnectedAt ??= Date.now()
          usePanelStore.setState({ progressError: null })
          if (Date.now() - disconnectedAt >= DISCONNECT_BUDGET_MS) {
            recovering = true; next = 5000
            usePanelStore.setState({ connectionError: store().task?.kind === 'ports'
              ? '等待面板恢复连接超时。请打开下方新地址；如果已回滚，请使用原地址，并在服务器查看维护日志。'
              : '等待面板恢复连接超时。面板可能仍在重启或执行维护，恢复后会自动重连；也可手动重新加载面板；如长时间未恢复，请在服务器查看维护日志。' })
          }
        } else {
          disconnectedAt = undefined
          usePanelStore.setState({ connectionError: null, progressError: cause instanceof Error ? cause.message : '读取维护任务失败' })
        }
      } finally {
        busy = false
        if (recovering) next = 5000
        else if (store().hasMore && !failed) next = 0
        else if (store().pending || (store().task && (panelTaskIsActive(store().task!) || store().task?.cliRegistration?.status === 'pending'))) next = Math.min(next, recovering ? 5000 : 2000)
        else next = Math.min(next, Math.max(0, discoverAt - Date.now()))
        schedule(next)
      }
    }
    const unsubscribe = usePanelStore.subscribe((state, previous) => {
      if (!busy && (state.task?.id !== previous.task?.id || state.pending?.requestId !== previous.pending?.requestId)) wake()
      if (previous.connectionError && !state.connectionError) { recovering = false; disconnectedAt = undefined; if (!busy) wake() }
    })
    void tick()
    return () => { stopped = true; abort.abort(); clearTimeout(timer); unsubscribe() }
  }, [gateway, phase])
  return <PanelReloadCountdown />
}
