import { randomId } from '../../utils/randomId'
import { SectionHelp } from '../../components/SectionHelp'
import { Terminal } from '../../components/icons'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { PANEL_TASK_PHASE_LABELS, PANEL_TASK_STATE_LABELS, PANEL_UPDATE_CHANNEL_LABELS, PANEL_UPDATE_SOURCE_LABELS, panelTaskIsActive, validatePanelPorts } from '@elysian/contracts'
import type { PanelTask, PanelUpdate, PanelUpdateChannel, PanelUpdateTarget } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { PanelHttpError } from '../../adapters/http/panelHttpAdapter'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { usePanelStore } from '../../stores/panelStore'
import { reloadPanelPage } from './panelNavigation'
import { panelAddress } from './panelAddress'
export { panelAddress } from './panelAddress'
import { PanelChangelogDialog } from './PanelChangelogDialog'
import { PanelResourcePreflightDialog } from './PanelResourcePreflightDialog'
import { ChipGroup } from '../../components/ChipGroup'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'
import { useMessageStore } from '../../stores/messageStore'
import { sendPanelPending } from './panelPending'
import type { PanelPending } from './panelPending'

const BUTTON = 'h-9 rounded-lg border border-control-line bg-surface-raised px-4 text-sm font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'
const INPUT = 'h-9 w-full rounded-lg border border-control-line bg-surface-raised px-3 text-sm tabular-nums text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'
function updateSummary(update: PanelUpdate): string {
  if (update.channel === 'release') {
    return !update.releaseTag ? '上游仓库暂无正式发版' : `${update.available ? '可切换至最新正式发版' : '当前已是最新正式发版'} · ${update.releaseTag}`
  }
  return `${update.available ? '发现可更新的提交' : '当前已是最新提交'} · ${update.branch}`
}

export function PanelMaintenanceSettings() {
  const gateway = useGateway()
  const info = usePanelStore((s) => s.info)
  const task = usePanelStore((s) => s.task)
  const trackedTaskId = usePanelStore((s) => s.trackedTaskId)
  const logs = usePanelStore((s) => s.logs)
  const logOffset = usePanelStore((s) => s.offset)
  const hasMore = usePanelStore((s) => s.hasMore)
  const logViewport = useRef<HTMLPreElement>(null)
  const [retryingCLI, setRetryingCLI] = useState(false)
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
  const [resourceTarget, setResourceTarget] = useState<PanelUpdateTarget | null>(null)
  /** 提交与校验错误按区块落持久行：端口区（含重启）与更新区各自展示，不再只靠自动消失的提示。 */
  const [portsError, setPortsError] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const progressError = usePanelStore(s => s.progressError)
  const connectionError = usePanelStore(s => s.connectionError)
  const verificationError = usePanelStore(s => s.verificationError)
  const needsManualReload = usePanelStore(s => s.needsManualReload)
  const verifiedUpdate = usePanelStore(s => s.verifiedUpdate)
  const pending = usePanelStore(s => s.pending)
  const setProgressError = (value: string | null) => usePanelStore.setState({ progressError: value })
  const setConnectionError = (value: string | null) => usePanelStore.setState({ connectionError: value })
  const requestId = useRef<{ key: string; id: string } | null>(null)
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const lifecycle = useRef(0)
  const submissionVersion = useRef(0)
  const active = task !== null && (panelTaskIsActive(task) || task.state === 'recovery-failed')
  // 成功更新不常驻进度卡；当前跟踪的任务须先核对版本，并保留未完成的 CLI 注册入口。
  const updateCompleted = task?.kind === 'update' && task.state === 'succeeded'
    && task.cliRegistration?.status !== 'pending' && task.cliRegistration?.status !== 'failed'
    && (trackedTaskId !== task.id || verifiedUpdate === task.id)
  const unavailable = !info?.available || active || submitting || pending !== null
  useFeedbackMessage(loadError ? `面板配置读取失败：${loadError}` : null)
  useFeedbackMessage(info && !info.available ? `面板维护不可用：${info.reason}` : null, 'warning')
  useFeedbackMessage(task?.state === 'succeeded' && (task.kind !== 'update' || verifiedUpdate === task.id) ? '面板维护已完成' : null, 'success')
  useFeedbackMessage(update ? `检查更新：${updateSummary(update)}` : null, 'info')

  // 首次展示、恢复任务及追加分页后都贴底；只滚动日志框，不移动设置页。
  useLayoutEffect(() => {
    const viewport = logViewport.current
    if (!viewport) return
    const follow = () => { viewport.scrollTop = viewport.scrollHeight }
    follow()
    // 设置页会保留隐藏页签；重新显示或换行宽度变化时也恢复贴底。
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(follow)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [logs, logOffset, task?.id])

  useEffect(() => {
    lifecycle.current++
    return () => { lifecycle.current++; checkVersion.current++ }
  }, [gateway])
  useEffect(() => {
    if (info) { setFrontend(String(info.ports.frontendPort)); setBackend(String(info.ports.backendPort)) }
  }, [info?.ports.frontendPort, info?.ports.backendPort])

  const rememberPending = (value: PanelPending | null) => {
    pendingRef.current = value; usePanelStore.getState().setPending(value)
  }
  const acceptTask = (result: PanelTask, expected: PanelPending) => {
    if (!usePanelStore.getState().acceptPending(result, expected.requestId)) return
    pendingRef.current = null; requestId.current = null
    setSubmitting(false)
    setProgressError(null); setConnectionError(null); setPortsError(null); setUpdateError(null)
    if (!usePanelStore.getState().info) void usePanelStore.getState().load(gateway, true)
    useMessageStore.getState().notify({ tone: 'info', message: '面板维护任务已提交' })
  }
  useEffect(() => {
    if (!pending) setSubmitting(false)
  }, [pending])
  useEffect(() => { requestId.current = null }, [task?.id])

  const retryCLI = async () => {
    if (!task || retryingCLI) return
    const id = task.id, generation = lifecycle.current, auth = captureAuthGeneration()
    const current = () => lifecycle.current === generation && captureAuthGeneration() === auth && usePanelStore.getState().task?.id === id
    setRetryingCLI(true); setProgressError(null)
    try { const result = await gateway.panel.retryCLIRegistration(id); if (current()) usePanelStore.getState().put(result) }
    catch (cause) { if (current()) setProgressError(cause instanceof Error ? cause.message : 'CLI 注册重试失败') }
    finally { if (current()) setRetryingCLI(false) }
  }

  const submit = async (key: string, input: Omit<PanelPending, 'version' | 'requestId'>, retryPending?: PanelPending) => {
    if (submitting || active || (pendingRef.current && !retryPending)) return
    const scope = lifecycle.current, auth = captureAuthGeneration()
    const version = ++submissionVersion.current
    const current = () => scope === lifecycle.current && auth === captureAuthGeneration()
    setSubmitting(true); setPortsError(null); setUpdateError(null); setProgressError(null); setConnectionError(null); usePanelStore.setState({ needsManualReload: false, verificationError: null })
    let saved = retryPending
    const isPortsAction = input.kind !== 'update'
    try {
      // 编号生成也可能失败，必须解除忙碌并显示具体原因；重试直接复用已有快照。
      if (!saved) {
        if (requestId.current?.key !== key) requestId.current = { key, id: randomId() }
        saved = { ...input, version: 1, requestId: requestId.current.id } as PanelPending
      }
      rememberPending(saved)
      const result = await sendPanelPending(gateway.panel, saved)
      if (current()) acceptTask(result, saved)
    }
    catch (cause) {
      if (!current() || (saved && usePanelStore.getState().pending?.requestId !== saved.requestId)) return
      const message = cause instanceof Error ? cause.message : '维护请求失败，请重试'
      if (!saved || (cause instanceof PanelHttpError && cause.status < 500)) {
        // 本地准备失败尚未发送请求，不进入「结果未确认」对账。
        if (saved) rememberPending(null)
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
      const result = await gateway.panel.checkUpdate(channel, 'github')
      if (current()) setUpdate(result)
    }
    catch (cause) { if (current()) setUpdateError(cause instanceof Error ? cause.message : '检查更新失败，请重试') }
    finally { if (current()) setChecking(false) }
  }
  const selectChannel = (next: PanelUpdateChannel) => {
    if (channel === next) return
    checkVersion.current += 1
    setChannel(next); setUpdate(null); setResourceTarget(null); setChecking(false); setUpdateError(null)
  }
  const beginUpdate = () => {
    if (!update || unavailable) return
    const target = { channel: update.channel, source: update.source, targetCommit: update.targetCommit, releaseTag: update.releaseTag }
    if (info?.resourcePreflightVersion) setResourceTarget(target)
    else void submit(`update:${target.source}:${target.channel}:${target.releaseTag}:${target.targetCommit}`, { kind: 'update', input: target })
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
      <div className="flex items-center gap-1.5"><h2 className="text-sm font-medium text-fg">面板更新</h2><SectionHelp label="面板更新说明">先下载并编译新版本，成功后重启。更新失败会恢复原版本，保留面板数据。资源不足时，先确认停机清单；提前停止面板后，构建期间页面暂时不可访问。</SectionHelp></div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <ChipGroup
          ariaLabel="更新策略"
          items={(['commit', 'release'] as const).map((value) => ({ value, label: PANEL_UPDATE_CHANNEL_LABELS[value] }))}
          value={channel}
          onSelect={selectChannel}
          className="max-w-full"
          disabled={active || submitting || pending !== null}
        />
      </div>
      <p className="mt-2 text-xs leading-5 text-fg-muted">{channel === 'commit' ? '跟随默认分支，获取最新改动。' : '使用最新正式发版，不包含预发布版本。'}</p>
      <div className="mt-3 space-y-2 text-xs leading-5 text-fg-muted"><p>更新来源：<a className="text-fg underline underline-offset-4" href="https://github.com/Tianyi822/Elysian" target="_blank" rel="noreferrer">GitHub · Tianyi822/Elysian</a> · {channel === 'commit' ? '默认分支' : '正式发版'}</p><p className="break-all">当前提交：{info?.commit ?? '正在读取…'}</p>{info?.buildTime && info.buildTime !== 'unknown' ? <p>构建时间：{info.buildTime}</p> : null}</div>
      {update ? <div role="status" className="mt-4 space-y-1 break-all text-xs leading-5 text-fg">
        <p>{updateSummary(update)}</p>
        <p>来源：{PANEL_UPDATE_SOURCE_LABELS[update.source]}</p>
        {update.targetCommit ? <p>目标提交：{update.targetCommit}</p> : null}
        {update.message && update.targetCommit ? <p className="text-fg-muted">{update.message}</p> : null}
      </div> : null}
      <div className="mt-4 flex flex-wrap gap-2"><button className={BUTTON} disabled={unavailable || checking} onClick={() => void check()}>{checking ? '正在检查…' : '检查更新'}</button><button className={BUTTON} disabled={unavailable || checking || !update?.available || update.channel !== channel || update.source !== 'github'} onClick={beginUpdate}>{submitting ? '正在提交…' : '更新并重启'}</button><button className={BUTTON} disabled={!info?.available} title={info && !info.available ? info.reason : undefined} onClick={() => setChangelogOpen(true)}>更新日志</button></div>
      {info?.available && !info.resourcePreflightVersion ? <p className="mt-2 text-xs leading-5 text-warning">当前服务器版本不支持更新资源预检。首次升级前请手动释放负载；不会自动停止其他业务。</p> : null}
      {updateError || verificationError ? <p role="alert" className="mt-3 break-all text-xs leading-5 text-danger">{updateError ?? verificationError}</p> : null}
    </section>
    {pending ? <section aria-label="维护提交结果" className="panel-surface p-5">
      <p role="status" className="text-xs leading-5 text-warning">{submitting ? '正在提交维护请求…' : '提交结果未确认，正在按请求编号核对。'}</p>
      <p className="mt-2 break-all text-xs text-fg-muted">请求编号：{pending.requestId}</p>
      {progressError ? <p role="alert" className="mt-2 text-xs text-danger">{progressError}</p> : null}
      <button className={`${BUTTON} mt-3`} disabled={submitting} onClick={() => void submit(pending.kind, { kind: pending.kind, input: pending.input }, pending)}>重试原维护请求</button>
    </section> : null}
    {task && !updateCompleted ? <section aria-label="面板维护进度" className="panel-surface p-5">
      <h2 className="text-sm font-medium text-fg">面板维护进度</h2>
      <p role="status" className="mt-3 text-xs leading-5 text-fg">{task.state === 'succeeded' && task.kind === 'update' && trackedTaskId === task.id && verifiedUpdate !== task.id ? '运行版本待确认' : PANEL_TASK_STATE_LABELS[task.state]} · {PANEL_TASK_PHASE_LABELS[task.phase] ?? task.phase}</p>
      {task.kind === 'update' ? <p className="mt-2 break-all text-xs leading-5 text-fg-muted">更新来源：{task.updateSource ? PANEL_UPDATE_SOURCE_LABELS[task.updateSource] : '未记录（历史任务）'}<br />更新策略：{PANEL_UPDATE_CHANNEL_LABELS[task.updateChannel ?? 'commit']}{task.releaseTag ? ` · ${task.releaseTag}` : ''}<br />目标提交：{task.targetCommit}</p> : null}
      {panelTaskIsActive(task) && task.workerDead ? <p role="status" className="mt-2 break-all text-xs leading-5 text-warning">维护进程已退出但任务尚未判定结果，等待服务器自动收敛；若长时间无变化，请在服务器执行 journalctl -u elysian-maintenance-{task.id} 查看现场。</p> : null}
      {panelTaskIsActive(task) && (task.workerStatus === 'unknown' || (task.workerStatus === undefined && !task.workerDead)) ? <p className="mt-2 text-xs leading-5 text-fg-muted">维护进程状态尚未确认，继续等待任务结果。</p> : null}
      {task.state === 'succeeded' && task.cliRegistration?.status === 'pending' ? <p role="status" className="mt-2 text-xs text-warning">面板升级成功，正在完成 CLI 注册…</p> : null}
      {task.state === 'succeeded' && task.cliRegistration?.status === 'failed' ? <div className="mt-3 space-y-2"><p role="alert" className="break-all text-xs text-danger">面板升级成功、CLI 注册失败：{task.cliRegistration.error}</p><button className={BUTTON} disabled={retryingCLI || active || submitting} onClick={() => void retryCLI()}>{retryingCLI ? '正在重试…' : '重试 CLI 注册'}</button></div> : null}
      {task.cliRegistration?.status === 'succeeded' ? <p role="status" className="mt-2 text-xs text-success">CLI 命令 ely 已注册</p> : null}
      {task.error ? <p role="alert" className="mt-2 break-all text-xs leading-5 text-danger">{task.error}</p> : null}
      {progressError ? <p role="alert" className="mt-2 break-all text-xs leading-5 text-danger">{progressError}</p> : null}
      {connectionError ? <div className="mt-3 space-y-2">
        <p role="alert" className="break-all text-xs leading-5 text-warning">{connectionError}</p>
        <div className="flex flex-wrap gap-2">
          <button className={BUTTON} onClick={() => { setConnectionError(null) }}>重新等待连接</button>
          {task.kind !== 'ports' ? <button className={BUTTON} onClick={() => reloadPanelPage()}>重新加载面板</button> : null}
        </div>
      </div> : null}
      {task.kind !== 'ports' && needsManualReload ? <button className={`${BUTTON} mt-3`} onClick={() => reloadPanelPage()}>重新加载面板</button> : null}
      {task.kind === 'ports' ? <div className="mt-3 flex flex-col gap-2 break-all text-xs"><a className="text-fg underline underline-offset-4" href={panelAddress(task.newPorts.frontendPort)}>打开新地址：{panelAddress(task.newPorts.frontendPort)}</a><a className="text-fg-muted underline underline-offset-4" href={panelAddress(task.oldPorts.frontendPort)}>打开原地址：{panelAddress(task.oldPorts.frontendPort)}</a></div> : null}
      {logs ? <div className="mt-4 overflow-hidden rounded-lg border border-line bg-[var(--t-code-bg)]">
        <div className="flex items-center gap-2 border-b border-line bg-surface-raised px-3 py-2 text-xs font-medium text-fg-muted">
          <Terminal aria-hidden size={14} className="shrink-0" />
          <span>维护进程日志</span>
        </div>
        <pre ref={logViewport} aria-label="维护任务日志" tabIndex={0} className="hover-scrollbar max-h-48 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-[var(--t-code-fg)] focus-visible:-outline-offset-2">{logs}</pre>
      </div> : null}
      {hasMore ? <p role="status" className="mt-3 text-xs text-fg-muted">正在读取最新日志…</p> : null}
    </section> : null}
    <PanelChangelogDialog open={changelogOpen} channel={channel} currentCommit={info?.commit ?? ''} onClose={() => setChangelogOpen(false)} />
    {resourceTarget ? <PanelResourcePreflightDialog target={resourceTarget} adapter={gateway.panel} onClose={() => setResourceTarget(null)} onConfirm={resourcePlan => {
      const target = { ...resourceTarget, resourcePlan }
      setResourceTarget(null)
      void submit(`update:${target.source}:${target.channel}:${target.releaseTag}:${target.targetCommit}:${JSON.stringify(resourcePlan)}`, { kind: 'update', input: target })
    }} /> : null}
  </>
}
