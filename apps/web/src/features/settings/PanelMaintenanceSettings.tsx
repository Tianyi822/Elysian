import { SectionHelp } from '../../components/SectionHelp'
import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { PANEL_TASK_PHASE_LABELS, PANEL_TASK_STATE_LABELS, PANEL_UPDATE_CHANNEL_LABELS, panelTaskIsActive, validatePanelPorts } from '@elysian/contracts'
import type { PanelTask, PanelUpdate, PanelUpdateChannel } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { PanelHttpError, PanelNetworkError, probeSameOriginHealth } from '../../adapters/http/panelHttpAdapter'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { usePanelStore } from '../../stores/panelStore'
import { openPanelAddress, reloadPanelPage } from './panelNavigation'
import { PanelChangelogDialog } from './PanelChangelogDialog'
import { ChipGroup } from '../../components/ChipGroup'
import { useFeedbackNotification } from '../../components/useFeedbackNotification'
import { useNotificationStore } from '../../stores/notificationStore'
import { readPanelPending, savePanelPending, sendPanelPending } from './panelPending'
import type { PanelPending } from './panelPending'

const BUTTON = 'h-9 rounded-lg border border-control-line bg-surface-raised px-4 text-sm font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'
const INPUT = 'h-9 w-full rounded-lg border border-control-line bg-surface-raised px-3 text-sm tabular-nums text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'
/** 网络断连计入「等待面板恢复」的预算；面板重启停机超过它就转入轻量健康探测。 */
const DISCONNECT_BUDGET_MS = 120000

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
  const trackedTaskId = usePanelStore((s) => s.trackedTaskId)
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
  /** 提交与校验错误按区块落持久行：端口区（含重启）与更新区各自展示，不再只靠自动消失的提示。 */
  const [portsError, setPortsError] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  /** 进度区错误：轮询收到的服务端错误与日志读取失败。 */
  const [progressError, setProgressError] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  /** 更新完成但版本核对未通过时，提供手动重新加载入口而不自动刷新。 */
  const [needsManualReload, setNeedsManualReload] = useState(false)
  const [retry, setRetry] = useState(0)
  const requestId = useRef<{ key: string; id: string } | null>(null)
  const [pending, setPending] = useState(readPanelPending)
  const pendingRef = useRef(pending)
  const lifecycle = useRef(0)
  const [verifiedUpdate, setVerifiedUpdate] = useState<string | null>(null)
  const submissionVersion = useRef(0)
  const active = task !== null && (panelTaskIsActive(task) || task.state === 'recovery-failed')
  const unavailable = !info?.available || active || submitting || pending !== null
  useFeedbackNotification(loadError ? `面板配置读取失败：${loadError}` : null)
  useFeedbackNotification(info && !info.available ? `面板维护不可用：${info.reason}` : null, 'warning')
  useFeedbackNotification(task?.state === 'succeeded' && (task.kind !== 'update' || verifiedUpdate === task.id) ? '面板维护已完成' : null, 'success')
  useFeedbackNotification(update ? `检查更新：${updateSummary(update)}` : null, 'info')

  useEffect(() => {
    lifecycle.current++
    void usePanelStore.getState().load(gateway)
    return () => { lifecycle.current++; checkVersion.current++ }
  }, [gateway])
  useEffect(() => {
    if (info) { setFrontend(String(info.ports.frontendPort)); setBackend(String(info.ports.backendPort)) }
  }, [info?.ports.frontendPort, info?.ports.backendPort])

  const rememberPending = (value: PanelPending | null) => {
    pendingRef.current = value; savePanelPending(value); setPending(value)
  }
  const acceptTask = (result: PanelTask, expected: PanelPending) => {
    if (pendingRef.current?.requestId !== expected.requestId) return
    rememberPending(null); requestId.current = null
    setSubmitting(false)
    setProgressError(null); setConnectionError(null); setPortsError(null); setUpdateError(null)
    usePanelStore.getState().put(result)
    if (!usePanelStore.getState().info) void usePanelStore.getState().load(gateway, true)
    useNotificationStore.getState().notify({ tone: 'info', message: '面板维护任务已提交' })
  }
  useEffect(() => {
    if (!pending) return
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    const auth = captureAuthGeneration(), abort = new AbortController()
    const current = () => !stopped && auth === captureAuthGeneration() && pendingRef.current?.requestId === pending.requestId
    const reconcile = async () => {
      try {
        const found = await gateway.panel.taskByRequest(pending.requestId, abort.signal)
        if (!current()) return
        if (found) { acceptTask(found, pending); return }
        setProgressError(null)
      } catch (cause) {
        if (!current()) return
        setProgressError(cause instanceof Error ? cause.message : '查询维护提交结果失败')
      }
      if (current()) timer = setTimeout(() => void reconcile(), 2000)
    }
    void reconcile()
    return () => { stopped = true; abort.abort(); if (timer) clearTimeout(timer) }
  }, [gateway, pending?.requestId])

  useEffect(() => {
    if (!task || panelTaskIsActive(task) || trackedTaskId !== task.id) return
    let stopped = false
    const auth = captureAuthGeneration(), abort = new AbortController()
    const current = () => !stopped && auth === captureAuthGeneration() && usePanelStore.getState().task?.id === task.id && usePanelStore.getState().trackedTaskId === task.id
    void (async () => {
      if (!current()) return
      setProgressError(null); setConnectionError(null)
      if (task.state === 'succeeded' && task.kind === 'update') {
        const probe = await probeSameOriginHealth(abort.signal)
        if (!current()) return
        if (probe && probe.commit !== '' && probe.commit === task.targetCommit) {
          setVerifiedUpdate(task.id); setUpdateError(null); reloadPanelPage(); return
        }
        setNeedsManualReload(true)
        setUpdateError(probe && probe.commit !== ''
          ? `面板已恢复，但运行版本 ${probe.commit.slice(0, 7)} 与目标提交不一致，未自动刷新页面；请查看任务日志或在服务器核实。`
          : '面板已恢复，但暂无法确认运行版本，未自动刷新页面；可手动重新加载后查看当前版本。')
      }
      if (current()) await usePanelStore.getState().load(gateway, true)
    })()
    return () => { stopped = true; abort.abort() }
  }, [gateway, task?.id, task?.state, trackedTaskId])

  useEffect(() => {
    if (!task || !panelTaskIsActive(task)) return
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, disconnectedAt: number | undefined
    const abort = new AbortController()
    const auth = captureAuthGeneration()
    const currentEffect = () => !stopped && auth === captureAuthGeneration() && usePanelStore.getState().task?.id === task.id
    // 断连预算耗尽后不再放弃监控：转入同源健康轻探测，面板恢复即自动重连轮询，
    // 由任务终态决定刷新或展示失败原因——重启断连期间既不误报失败也不提前宣布成功。
    const probeRecovery = () => {
      if (!currentEffect()) return
      void probeSameOriginHealth(abort.signal).then((probe) => {
        if (!currentEffect()) return
        if (probe) {
          setConnectionError(null)
          setRetry((value) => value + 1)
          return
        }
        timer = setTimeout(probeRecovery, 5000)
      })
    }
    const tick = async () => {
      if (!currentEffect()) return
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
          if (!currentEffect()) return
          if (ready) { nextUrl.searchParams.set('maintenanceTask', current.id); openPanelAddress(nextUrl.toString()); return }
        }
        const report = await usePanelStore.getState().poll(gateway)
        if (report && !panelTaskIsActive(report.task)) {
          return
        }
        if (!currentEffect()) return
        setConnectionError(null); setProgressError(null); disconnectedAt = undefined
      } catch (cause) {
        if (!currentEffect()) return
        if (cause instanceof PanelNetworkError) {
          // 网络不可达才计入断连预算：服务重启停机期间不误报失败。
          setProgressError(null)
          disconnectedAt ??= Date.now()
          if (Date.now() - disconnectedAt >= DISCONNECT_BUDGET_MS) {
            if (!stopped) {
              setConnectionError(current.kind === 'ports'
                ? '等待面板恢复连接超时。请打开下方新地址；如果已回滚，请使用原地址，并在服务器查看维护日志。'
                : '等待面板恢复连接超时。面板可能仍在重启或执行维护，恢复后会自动重连；也可手动重新加载面板；如长时间未恢复，请在服务器查看维护日志。')
              probeRecovery()
            }
            return
          }
        } else {
          // HTTP 错误响应：面板可达且给出了原因，立即显示服务端错误，不计断连预算。
          disconnectedAt = undefined
          setConnectionError(null)
          setProgressError(cause instanceof Error ? cause.message : '读取维护任务失败')
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), 2000)
    }
    timer = setTimeout(() => void tick(), 1000)
    return () => { stopped = true; abort.abort(); if (timer) clearTimeout(timer) }
  }, [gateway, task?.id, task?.state, retry])

  const submit = async (key: string, input: Omit<PanelPending, 'version' | 'requestId'>, retryPending?: PanelPending) => {
    if (submitting || active || (pendingRef.current && !retryPending)) return
    const scope = lifecycle.current, auth = captureAuthGeneration()
    const version = ++submissionVersion.current
    const current = () => scope === lifecycle.current && auth === captureAuthGeneration()
    setSubmitting(true); setPortsError(null); setUpdateError(null); setProgressError(null); setConnectionError(null); setNeedsManualReload(false); setVerifiedUpdate(null)
    if (requestId.current?.key !== key) requestId.current = { key, id: crypto.randomUUID() }
    const saved = retryPending ?? { ...input, version: 1, requestId: requestId.current.id } as PanelPending
    rememberPending(saved)
    const isPortsAction = saved.kind !== 'update'
    try {
      const result = await sendPanelPending(gateway.panel, saved)
      if (current()) acceptTask(result, saved)
    }
    catch (cause) {
      if (!current() || pendingRef.current?.requestId !== saved.requestId) return
      const message = cause instanceof Error ? cause.message : '维护请求失败，请重试'
      if (cause instanceof PanelHttpError && cause.status < 500) {
        rememberPending(null)
        if (isPortsAction) setPortsError(message); else setUpdateError(message)
      } else {
        setProgressError(message)
      }
    }
    finally { if (current() && version === submissionVersion.current) setSubmitting(false) }
  }
  const onPorts = (event: FormEvent) => {
    event.preventDefault()
    const ports = { frontendPort: Number(frontend), backendPort: Number(backend) }
    const invalid = validatePanelPorts(ports)
    if (invalid || !/^[0-9]+$/.test(frontend) || !/^[0-9]+$/.test(backend)) { setPortsError(invalid ?? '端口必须是 1–65535 的整数'); return }
    void submit(`ports:${frontend}:${backend}`, { kind: 'ports', input: ports })
  }
  const check = async () => {
    const version = ++checkVersion.current
    const auth = captureAuthGeneration(), scope = lifecycle.current
    const current = () => version === checkVersion.current && auth === captureAuthGeneration() && scope === lifecycle.current
    setChecking(true); setUpdateError(null); setUpdate(null)
    try {
      const result = await gateway.panel.checkUpdate(channel)
      if (current()) setUpdate(result)
    }
    catch (cause) { if (current()) setUpdateError(cause instanceof Error ? cause.message : '检查更新失败，请重试') }
    finally { if (current()) setChecking(false) }
  }
  const selectChannel = (next: PanelUpdateChannel) => {
    if (channel === next) return
    checkVersion.current += 1
    setChannel(next); setUpdate(null); setChecking(false); setUpdateError(null)
  }
  const readMoreLogs = async () => {
    const scope = lifecycle.current, auth = captureAuthGeneration(), id = task?.id
    const current = () => scope === lifecycle.current && auth === captureAuthGeneration() && usePanelStore.getState().task?.id === id
    setLoadingLogs(true)
    try { if (await usePanelStore.getState().poll(gateway) && current()) setProgressError(null) }
    catch (cause) { if (current()) setProgressError(cause instanceof Error ? cause.message : '读取维护日志失败') }
    finally { if (current()) setLoadingLogs(false) }
  }
  return <>
    <section aria-label="面板端口" className="panel-surface p-5">
      <div className="flex items-center gap-1.5"><h2 className="text-sm font-medium text-fg">面板端口</h2><SectionHelp label="面板端口说明">前端端口用于打开面板，后端端口供面板内部使用。保存后会重启，页面会短暂断开。</SectionHelp></div>
      {!info && !loadError ? <p role="status" className="mt-3 text-xs text-fg-muted">正在读取面板配置…</p> : null}
      {loadError ? <div className="mt-3"><p role="alert" className="text-xs text-danger">{loadError}</p><button className={`${BUTTON} mt-3`} onClick={() => void usePanelStore.getState().load(gateway)}>重新读取配置</button></div> : null}
      {info && !info.available ? <p role="status" className="mt-3 text-xs leading-5 text-fg-muted">{info.reason}</p> : null}
      <form onSubmit={onPorts} className="mt-5 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div><label htmlFor={frontendId} className="mb-2 block text-xs font-medium text-fg">前端端口</label><input id={frontendId} inputMode="numeric" value={frontend} onChange={(e) => { setFrontend(e.target.value); setPortsError(null) }} disabled={unavailable} className={INPUT} /></div>
          <div><label htmlFor={backendId} className="mb-2 block text-xs font-medium text-fg">后端端口</label><input id={backendId} inputMode="numeric" value={backend} onChange={(e) => { setBackend(e.target.value); setPortsError(null) }} disabled={unavailable} className={INPUT} /></div>
        </div>
        {portsError ? <p role="alert" className="break-all text-xs leading-5 text-danger">{portsError}</p> : null}
        <div className="flex flex-wrap gap-2"><button type="submit" disabled={unavailable} className={BUTTON}>{submitting ? '正在提交…' : '保存并重启'}</button><button type="button" disabled={unavailable} className={BUTTON} onClick={() => void submit('restart', { kind: 'restart', input: null })}>{submitting ? '正在提交…' : '重启面板'}</button></div>
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
        disabled={active || submitting || pending !== null}
      />
      <p className="mt-2 text-xs leading-5 text-fg-muted">{channel === 'commit' ? '跟随默认分支，获取最新改动。' : '使用最新正式发版，不包含预发布版本。'}</p>
      <div className="mt-3 space-y-2 text-xs leading-5 text-fg-muted"><p>更新来源：<a className="text-fg underline underline-offset-4" href="https://github.com/Tianyi822/Elysian" target="_blank" rel="noreferrer">Tianyi822/Elysian</a> · {channel === 'commit' ? '默认分支' : '正式发版'}</p><p className="break-all">当前提交：{info?.commit ?? '正在读取…'}</p>{info?.buildTime && info.buildTime !== 'unknown' ? <p>构建时间：{info.buildTime}</p> : null}</div>
      {update ? <div role="status" className="mt-4 space-y-1 break-all text-xs leading-5 text-fg">
        <p>{updateSummary(update)}</p>
        {update.targetCommit ? <p>目标提交：{update.targetCommit}</p> : null}
        {update.message && update.targetCommit ? <p className="text-fg-muted">{update.message}</p> : null}
      </div> : null}
      <div className="mt-4 flex flex-wrap gap-2"><button className={BUTTON} disabled={unavailable || checking} onClick={() => void check()}>{checking ? '正在检查…' : '检查更新'}</button><button className={BUTTON} disabled={unavailable || checking || !update?.available || update.channel !== channel} onClick={() => update && void submit(`update:${update.channel}:${update.releaseTag}:${update.targetCommit}`, { kind: 'update', input: { channel: update.channel, targetCommit: update.targetCommit, releaseTag: update.releaseTag } })}>{submitting ? '正在提交…' : '更新并重启'}</button><button className={BUTTON} disabled={!info?.available} title={info && !info.available ? info.reason : undefined} onClick={() => setChangelogOpen(true)}>更新日志</button></div>
      {updateError ? <p role="alert" className="mt-3 break-all text-xs leading-5 text-danger">{updateError}</p> : null}
    </section>
    {pending ? <section aria-label="维护提交结果" className="panel-surface p-5">
      <p role="status" className="text-xs leading-5 text-warning">{submitting ? '正在提交维护请求…' : '提交结果未确认，正在按请求编号核对。'}</p>
      <p className="mt-2 break-all text-xs text-fg-muted">请求编号：{pending.requestId}</p>
      {progressError ? <p role="alert" className="mt-2 text-xs text-danger">{progressError}</p> : null}
      <button className={`${BUTTON} mt-3`} disabled={submitting} onClick={() => void submit(pending.kind, { kind: pending.kind, input: pending.input }, pending)}>重试原维护请求</button>
    </section> : null}
    {task ? <section aria-label="面板维护进度" className="panel-surface p-5">
      <h2 className="text-sm font-medium text-fg">面板维护进度</h2>
      <p role="status" className="mt-3 text-xs leading-5 text-fg">{task.state === 'succeeded' && task.kind === 'update' && trackedTaskId === task.id && verifiedUpdate !== task.id ? '运行版本待确认' : PANEL_TASK_STATE_LABELS[task.state]} · {PANEL_TASK_PHASE_LABELS[task.phase] ?? task.phase}</p>
      {task.kind === 'update' ? <p className="mt-2 break-all text-xs leading-5 text-fg-muted">更新策略：{PANEL_UPDATE_CHANNEL_LABELS[task.updateChannel ?? 'commit']}{task.releaseTag ? ` · ${task.releaseTag}` : ''}<br />目标提交：{task.targetCommit}</p> : null}
      {panelTaskIsActive(task) && task.workerDead ? <p role="status" className="mt-2 break-all text-xs leading-5 text-warning">维护进程已退出但任务尚未判定结果，等待服务器自动收敛；若长时间无变化，请在服务器执行 journalctl -u elysian-maintenance-{task.id} 查看现场。</p> : null}
      {panelTaskIsActive(task) && (task.workerStatus === 'unknown' || (task.workerStatus === undefined && !task.workerDead)) ? <p className="mt-2 text-xs leading-5 text-fg-muted">维护进程状态尚未确认，继续等待任务结果。</p> : null}
      {task.error ? <p role="alert" className="mt-2 break-all text-xs leading-5 text-danger">{task.error}</p> : null}
      {progressError ? <p role="alert" className="mt-2 break-all text-xs leading-5 text-danger">{progressError}</p> : null}
      {connectionError ? <div className="mt-3 space-y-2">
        <p role="alert" className="break-all text-xs leading-5 text-warning">{connectionError}</p>
        <div className="flex flex-wrap gap-2">
          <button className={BUTTON} onClick={() => { setConnectionError(null); setRetry((v) => v + 1) }}>重新等待连接</button>
          {task.kind !== 'ports' ? <button className={BUTTON} onClick={() => reloadPanelPage()}>重新加载面板</button> : null}
        </div>
      </div> : null}
      {task.kind !== 'ports' && needsManualReload ? <button className={`${BUTTON} mt-3`} onClick={() => reloadPanelPage()}>重新加载面板</button> : null}
      {task.kind === 'ports' ? <div className="mt-3 flex flex-col gap-2 break-all text-xs"><a className="text-fg underline underline-offset-4" href={panelAddress(task.newPorts.frontendPort)}>打开新地址：{panelAddress(task.newPorts.frontendPort)}</a><a className="text-fg-muted underline underline-offset-4" href={panelAddress(task.oldPorts.frontendPort)}>打开原地址：{panelAddress(task.oldPorts.frontendPort)}</a></div> : null}
      {logs ? <pre aria-label="维护任务日志" className="mt-4 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-fg-muted">{logs}</pre> : null}
      {hasMore ? <button className={`${BUTTON} mt-3`} disabled={loadingLogs} onClick={() => void readMoreLogs()}>{loadingLogs ? '正在读取…' : '继续读取日志'}</button> : null}
    </section> : null}
    <PanelChangelogDialog open={changelogOpen} channel={channel} currentCommit={info?.commit ?? ''} onClose={() => setChangelogOpen(false)} />
  </>
}
