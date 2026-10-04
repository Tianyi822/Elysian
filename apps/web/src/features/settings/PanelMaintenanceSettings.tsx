import { SectionHelp } from '../../components/SectionHelp'
import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { PANEL_TASK_PHASE_LABELS, PANEL_TASK_STATE_LABELS, panelTaskIsActive, validatePanelPorts } from '@elysian/contracts'
import type { PanelTask, PanelUpdate } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { usePanelStore } from '../../stores/panelStore'
import { openPanelAddress, reloadPanelPage } from './panelNavigation'
import { PanelChangelogDialog } from './PanelChangelogDialog'

const BUTTON = 'h-9 rounded-lg border border-control-line bg-surface-raised px-4 text-sm font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'
const INPUT = 'h-9 w-full rounded-lg border border-control-line bg-surface-raised px-3 text-sm tabular-nums text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'

/** 只替换端口，保留浏览器实际使用的 IP（包括 IPv6），不接受服务端任意跳转地址。 */
export function panelAddress(port: number, origin = window.location.origin): string {
  const url = new URL(origin); url.port = String(port); url.pathname = '/settings'; url.search = ''; url.hash = ''
  return url.toString()
}

export function PanelMaintenanceSettings() {
  const gateway = useGateway()
  const info = usePanelStore((s) => s.info)
  const task = usePanelStore((s) => s.task)
  const logs = usePanelStore((s) => s.logs)
  const hasMore = usePanelStore((s) => s.hasMore)
  const [loadingLogs, setLoadingLogs] = useState(false)
  const loadError = usePanelStore((s) => s.error)
  const frontendId = useId(), backendId = useId()
  const [frontend, setFrontend] = useState('')
  const [backend, setBackend] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [update, setUpdate] = useState<PanelUpdate | null>(null)
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const requestId = useRef<{ key: string; id: string } | null>(null)
  const active = task !== null && (panelTaskIsActive(task) || task.state === 'recovery-failed')
  const unavailable = !info?.available || active || submitting

  useEffect(() => { void usePanelStore.getState().load(gateway) }, [gateway])
  useEffect(() => {
    if (info) { setFrontend(String(info.ports.frontendPort)); setBackend(String(info.ports.backendPort)) }
  }, [info?.ports.frontendPort, info?.ports.backendPort])

  useEffect(() => {
    if (!task || !panelTaskIsActive(task)) return
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, disconnectedAt: number | undefined
    const abort = new AbortController()
    const tick = async () => {
      if (stopped) return
      const current = usePanelStore.getState().task
      if (!current || current.id !== task.id) return
      try {
        const nextUrl = new URL(panelAddress(current.newPorts.frontendPort))
        if (nextUrl.origin !== window.location.origin) {
          const probeAbort = new AbortController()
          const cancelProbe = () => probeAbort.abort()
          abort.signal.addEventListener('abort', cancelProbe, { once: true })
          const probeTimer = setTimeout(cancelProbe, 3000)
          let ready = false
          try { ready = await gateway.panel.ready(nextUrl.origin, current.id, probeAbort.signal) } catch { /* 重启期间入口可能暂时不可达。 */ }
          finally { clearTimeout(probeTimer); abort.signal.removeEventListener('abort', cancelProbe) }
          if (ready && !stopped) { nextUrl.searchParams.set('maintenanceTask', current.id); openPanelAddress(nextUrl.toString()); return }
        }
        const report = await usePanelStore.getState().poll(gateway)
        if (stopped) return
        setConnectionError(null); disconnectedAt = undefined
        if (report && !panelTaskIsActive(report.task)) {
          if (report.task.state === 'succeeded' && report.task.kind === 'update') { reloadPanelPage(); return }
          await usePanelStore.getState().load(gateway); return
        }
      } catch {
        disconnectedAt ??= Date.now()
        if (Date.now() - disconnectedAt >= 120000) {
          if (!stopped) setConnectionError('等待面板恢复连接超时。请打开下方新地址；如果已回滚，请使用原地址，并在服务器查看维护日志。')
          return
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), 2000)
    }
    timer = setTimeout(() => void tick(), 1000)
    return () => { stopped = true; abort.abort(); if (timer) clearTimeout(timer) }
  }, [gateway, task?.id, task?.state, retry])

  const submit = async (key: string, action: (id: string) => Promise<PanelTask>) => {
    if (submitting || active) return
    setSubmitting(true); setError(null); setConnectionError(null)
    if (requestId.current?.key !== key) requestId.current = { key, id: crypto.randomUUID() }
    try { const result = await action(requestId.current.id); usePanelStore.getState().put(result); requestId.current = null }
    catch (cause) { setError(cause instanceof Error ? cause.message : '维护请求失败，请重试') }
    finally { setSubmitting(false) }
  }
  const onPorts = (event: FormEvent) => {
    event.preventDefault()
    const ports = { frontendPort: Number(frontend), backendPort: Number(backend) }
    const invalid = validatePanelPorts(ports)
    if (invalid || !/^[0-9]+$/.test(frontend) || !/^[0-9]+$/.test(backend)) { setError(invalid ?? '端口必须是 1–65535 的整数'); return }
    void submit(`ports:${frontend}:${backend}`, (id) => gateway.panel.ports(ports, id))
  }
  const check = async () => {
    setChecking(true); setError(null)
    try { setUpdate(await gateway.panel.checkUpdate()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '检查更新失败，请重试') }
    finally { setChecking(false) }
  }
  return <>
    <section aria-label="面板端口" className="panel-surface p-5">
      <div className="flex items-center gap-1.5"><h2 className="text-sm font-medium text-fg">面板端口</h2><SectionHelp label="面板端口说明">前端端口用于打开面板，后端端口供面板内部使用。保存后会重启，页面会短暂断开。</SectionHelp></div>
      {!info && !loadError ? <p role="status" className="mt-3 text-xs text-fg-muted">正在读取面板配置…</p> : null}
      {loadError ? <div className="mt-3"><p role="alert" className="text-xs text-danger">{loadError}</p><button className={`${BUTTON} mt-3`} onClick={() => void usePanelStore.getState().load(gateway)}>重新读取配置</button></div> : null}
      {info && !info.available ? <p role="status" className="mt-3 text-xs leading-5 text-fg-muted">{info.reason}</p> : null}
      <form onSubmit={onPorts} className="mt-5 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div><label htmlFor={frontendId} className="mb-2 block text-xs font-medium text-fg">前端端口</label><input id={frontendId} inputMode="numeric" value={frontend} onChange={(e) => { setFrontend(e.target.value); setError(null) }} disabled={unavailable} className={INPUT} /></div>
          <div><label htmlFor={backendId} className="mb-2 block text-xs font-medium text-fg">后端端口</label><input id={backendId} inputMode="numeric" value={backend} onChange={(e) => { setBackend(e.target.value); setError(null) }} disabled={unavailable} className={INPUT} /></div>
        </div>
        <div className="flex flex-wrap gap-2"><button type="submit" disabled={unavailable} className={BUTTON}>{submitting ? '正在提交…' : '保存并重启'}</button><button type="button" disabled={unavailable} className={BUTTON} onClick={() => void submit('restart', (id) => gateway.panel.restart(id))}>重启面板</button></div>
      </form>
    </section>
    <section aria-label="面板更新" className="panel-surface p-5">
      <div className="flex items-center gap-1.5"><h2 className="text-sm font-medium text-fg">面板更新</h2><SectionHelp label="面板更新说明">先下载并编译新版本，成功后重启。更新失败会恢复原版本，保留面板数据。</SectionHelp></div>
      <div className="mt-3 space-y-2 text-xs leading-5 text-fg-muted"><p>更新来源：<a className="text-fg underline underline-offset-4" href="https://github.com/Tianyi822/Elysian" target="_blank" rel="noreferrer">Tianyi822/Elysian</a> 的默认分支</p><p className="break-all">当前提交：{info?.commit ?? '正在读取…'}</p>{info?.buildTime && info.buildTime !== 'unknown' ? <p>构建时间：{info.buildTime}</p> : null}</div>
      {update ? <div role="status" className="mt-4 space-y-1 break-all text-xs leading-5 text-fg"><p>{update.available ? '发现可更新的提交' : '当前已是最新提交'} · {update.branch}</p><p>目标提交：{update.targetCommit}</p>{update.message ? <p className="text-fg-muted">{update.message}</p> : null}</div> : null}
      <div className="mt-4 flex flex-wrap gap-2"><button className={BUTTON} disabled={unavailable || checking} onClick={() => void check()}>{checking ? '正在检查…' : '检查更新'}</button><button className={BUTTON} disabled={unavailable || checking || !update?.available} onClick={() => update && void submit(`update:${update.targetCommit}`, (id) => gateway.panel.update(update.targetCommit, id))}>更新并重启</button><button className={BUTTON} disabled={!info?.available} title={info && !info.available ? info.reason : undefined} onClick={() => setChangelogOpen(true)}>更新日志</button></div>
    </section>
    {error ? <p role="alert" className="rounded-lg border border-danger/40 p-3 text-xs leading-5 text-danger">{error}</p> : null}
    {task ? <section aria-label="面板维护进度" className="panel-surface p-5">
      <h2 className="text-sm font-medium text-fg">面板维护进度</h2><p role="status" className="mt-3 text-xs leading-5 text-fg">{PANEL_TASK_STATE_LABELS[task.state]} · {PANEL_TASK_PHASE_LABELS[task.phase] ?? task.phase}</p>
      {task.error ? <p role="alert" className="mt-3 break-words text-xs leading-5 text-danger">{task.error}</p> : null}
      {connectionError ? <div className="mt-3"><p role="alert" className="text-xs leading-5 text-warning">{connectionError}</p><button className={`${BUTTON} mt-3`} onClick={() => { setConnectionError(null); setRetry((v) => v + 1) }}>重新等待连接</button></div> : null}
      {task.kind === 'ports' ? <div className="mt-3 flex flex-col gap-2 break-all text-xs"><a className="text-fg underline underline-offset-4" href={panelAddress(task.newPorts.frontendPort)}>打开新地址：{panelAddress(task.newPorts.frontendPort)}</a><a className="text-fg-muted underline underline-offset-4" href={panelAddress(task.oldPorts.frontendPort)}>打开原地址：{panelAddress(task.oldPorts.frontendPort)}</a></div> : null}
      {logs ? <pre aria-label="维护任务日志" className="mt-4 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-fg-muted">{logs}</pre> : null}
      {hasMore ? <button className={`${BUTTON} mt-3`} disabled={loadingLogs} onClick={() => { setLoadingLogs(true); void usePanelStore.getState().poll(gateway).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '读取维护日志失败')).finally(() => setLoadingLogs(false)) }}>{loadingLogs ? '正在读取…' : '继续读取日志'}</button> : null}
    </section> : null}
    <PanelChangelogDialog open={changelogOpen} currentCommit={info?.commit ?? ''} onClose={() => setChangelogOpen(false)} />
  </>
}
