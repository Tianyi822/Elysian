import { SectionHelp } from '../../components/SectionHelp'
import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { PANEL_TASK_PHASE_LABELS, PANEL_TASK_STATE_LABELS, PANEL_UPDATE_CHANNEL_LABELS, panelTaskIsActive, validatePanelPorts } from '@elysian/contracts'
import type { PanelTask, PanelUpdate, PanelUpdateChannel } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { usePanelStore } from '../../stores/panelStore'
import { openPanelAddress, reloadPanelPage } from './panelNavigation'
import { PanelChangelogDialog } from './PanelChangelogDialog'
import { ChipGroup } from '../../components/ChipGroup'
import { useFeedbackNotification } from '../../components/useFeedbackNotification'
import { useNotificationStore } from '../../stores/notificationStore'

const BUTTON = 'h-9 rounded-lg border border-control-line bg-surface-raised px-4 text-sm font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'
const INPUT = 'h-9 w-full rounded-lg border border-control-line bg-surface-raised px-3 text-sm tabular-nums text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'

function updateSummary(update: PanelUpdate): string {
  if (update.channel === 'release') {
    return !update.releaseTag ? '上游仓库暂无正式发版' : `${update.available ? '可切换至最新正式发版' : '当前已是最新正式发版'} · ${update.releaseTag}`
  }
  return `${update.available ? '发现可更新的提交' : '当前已是最新提交'} · ${update.branch}`
}

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
  const [channel, setChannel] = useState<PanelUpdateChannel>('commit')
  const [update, setUpdate] = useState<PanelUpdate | null>(null)
  const checkVersion = useRef(0)
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const requestId = useRef<{ key: string; id: string } | null>(null)
  const active = task !== null && (panelTaskIsActive(task) || task.state === 'recovery-failed')
  const unavailable = !info?.available || active || submitting
  useFeedbackNotification(loadError ? `面板配置读取失败：${loadError}` : null)
  useFeedbackNotification(error)
  useFeedbackNotification(connectionError, 'warning')
  useFeedbackNotification(info && !info.available ? `面板维护不可用：${info.reason}` : null, 'warning')
  useFeedbackNotification(task?.error)
  useFeedbackNotification(task?.state === 'succeeded' ? '面板维护已完成' : null, 'success')
  useFeedbackNotification(update ? `检查更新：${updateSummary(update)}` : null, 'info')

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
    try {
      const result = await action(requestId.current.id)
      usePanelStore.getState().put(result); requestId.current = null
      useNotificationStore.getState().notify({ tone: 'info', message: '面板维护任务已提交' })
    }
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
    const version = ++checkVersion.current
    setChecking(true); setError(null); setUpdate(null)
    try {
      const result = await gateway.panel.checkUpdate(channel)
      if (version === checkVersion.current) setUpdate(result)
    }
    catch (cause) { if (version === checkVersion.current) setError(cause instanceof Error ? cause.message : '检查更新失败，请重试') }
    finally { if (version === checkVersion.current) setChecking(false) }
  }
  const selectChannel = (next: PanelUpdateChannel) => {
    if (channel === next) return
    checkVersion.current += 1
    setChannel(next); setUpdate(null); setChecking(false); setError(null)
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
      <ChipGroup
        ariaLabel="更新策略"
        items={(['commit', 'release'] as const).map((value) => ({ value, label: PANEL_UPDATE_CHANNEL_LABELS[value] }))}
        value={channel}
        onSelect={selectChannel}
        className="mt-4 max-w-full"
        disabled={active || submitting}
      />
      <p className="mt-2 text-xs leading-5 text-fg-muted">{channel === 'commit' ? '跟随默认分支，获取最新改动。' : '使用最新正式发版，不包含预发布版本。'}</p>
      <div className="mt-3 space-y-2 text-xs leading-5 text-fg-muted"><p>更新来源：<a className="text-fg underline underline-offset-4" href="https://github.com/Tianyi822/Elysian" target="_blank" rel="noreferrer">Tianyi822/Elysian</a> · {channel === 'commit' ? '默认分支' : '正式发版'}</p><p className="break-all">当前提交：{info?.commit ?? '正在读取…'}</p>{info?.buildTime && info.buildTime !== 'unknown' ? <p>构建时间：{info.buildTime}</p> : null}</div>
      {update ? <div role="status" className="mt-4 space-y-1 break-all text-xs leading-5 text-fg">
        <p>{updateSummary(update)}</p>
        {update.targetCommit ? <p>目标提交：{update.targetCommit}</p> : null}
        {update.message && update.targetCommit ? <p className="text-fg-muted">{update.message}</p> : null}
      </div> : null}
      <div className="mt-4 flex flex-wrap gap-2"><button className={BUTTON} disabled={unavailable || checking} onClick={() => void check()}>{checking ? '正在检查…' : '检查更新'}</button><button className={BUTTON} disabled={unavailable || checking || !update?.available || update.channel !== channel} onClick={() => update && void submit(`update:${update.channel}:${update.releaseTag}:${update.targetCommit}`, (id) => gateway.panel.update({ channel: update.channel, targetCommit: update.targetCommit, releaseTag: update.releaseTag }, id))}>更新并重启</button><button className={BUTTON} disabled={!info?.available} title={info && !info.available ? info.reason : undefined} onClick={() => setChangelogOpen(true)}>更新日志</button></div>
    </section>
    {task ? <section aria-label="面板维护进度" className="panel-surface p-5">
      <h2 className="text-sm font-medium text-fg">面板维护进度</h2><p role="status" className="mt-3 text-xs leading-5 text-fg">{PANEL_TASK_STATE_LABELS[task.state]} · {PANEL_TASK_PHASE_LABELS[task.phase] ?? task.phase}</p>
      {task.kind === 'update' ? <p className="mt-2 break-all text-xs leading-5 text-fg-muted">更新策略：{PANEL_UPDATE_CHANNEL_LABELS[task.updateChannel ?? 'commit']}{task.releaseTag ? ` · ${task.releaseTag}` : ''}<br />目标提交：{task.targetCommit}</p> : null}
      {connectionError ? <button className={`${BUTTON} mt-3`} onClick={() => { setConnectionError(null); setRetry((v) => v + 1) }}>重新等待连接</button> : null}
      {task.kind === 'ports' ? <div className="mt-3 flex flex-col gap-2 break-all text-xs"><a className="text-fg underline underline-offset-4" href={panelAddress(task.newPorts.frontendPort)}>打开新地址：{panelAddress(task.newPorts.frontendPort)}</a><a className="text-fg-muted underline underline-offset-4" href={panelAddress(task.oldPorts.frontendPort)}>打开原地址：{panelAddress(task.oldPorts.frontendPort)}</a></div> : null}
      {logs ? <pre aria-label="维护任务日志" className="mt-4 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-fg-muted">{logs}</pre> : null}
      {hasMore ? <button className={`${BUTTON} mt-3`} disabled={loadingLogs} onClick={() => { setLoadingLogs(true); void usePanelStore.getState().poll(gateway).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '读取维护日志失败')).finally(() => setLoadingLogs(false)) }}>{loadingLogs ? '正在读取…' : '继续读取日志'}</button> : null}
    </section> : null}
    <PanelChangelogDialog open={changelogOpen} channel={channel} currentCommit={info?.commit ?? ''} onClose={() => setChangelogOpen(false)} />
  </>
}
