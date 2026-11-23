import { randomId } from '../../utils/randomId'
import { SectionHelp } from '../../components/SectionHelp'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { PANEL_TASK_STATE_LABELS, PANEL_UPDATE_SOURCE_LABELS, panelTaskIsActive, validatePanelPorts } from '@elysian/contracts'
import type { PanelTask, PanelUpdate, PanelUpdateSource, PanelUpdateTarget } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { PanelHttpError } from '../../adapters/http/panelHttpAdapter'
import { captureAuthGeneration } from '../../utils/authGeneration'
import { usePanelStore } from '../../stores/panelStore'
import { reloadPanelPage } from '../../utils/panelNavigation'
import { panelAddress } from '../../utils/panelAddress'
export { panelAddress } from '../../utils/panelAddress'
import { PanelChangelogDialog } from './PanelChangelogDialog'
import { PanelResourcePreflightDialog } from './PanelResourcePreflightDialog'
import { PanelMaintenanceProgress, panelMaintenancePhaseLabel } from './PanelMaintenanceProgress'
import { isMaintenanceErrorLogged, PanelMaintenanceLog } from './PanelMaintenanceLog'
import { ChipGroup } from '../../components/ChipGroup'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'
import { useImeEnterGuard } from '../../components/useImeEnterGuard'
import { useMessageStore } from '../../stores/messageStore'
import { sendPanelPending, type PanelPending } from '../../stores/panelPending'
import { Button } from '../../components/Button'
import { Badge } from '../../components/easyui/Badge'
import { formatDateTimeWithYear } from '../../components/format'
import { IconButton } from '../../components/IconButton'
import { ExternalLink } from '../../components/icons'
import { FORM_CONTROL_HEIGHT_CLASS, MAINTENANCE_FORM_ACTION_CLASS } from '../../components/formControl'
import { messageOf } from '../../utils/errorMessage'

const BUTTON = `${MAINTENANCE_FORM_ACTION_CLASS} transition-colors hover:border-fg-subtle`
const INPUT = `${FORM_CONTROL_HEIGHT_CLASS} w-full rounded-lg border border-control-line bg-surface-raised px-3 text-sm tabular-nums text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50`
function updateStatusLabel(update: PanelUpdate, currentVersion: string | undefined): string {
  if (!update.releaseTag) return '暂无可用发版'
  if (!update.available) return '已是最新版本'
  return update.releaseTag === currentVersion ? '可更新' : `可更新至 ${update.releaseTag}`
}

export function PanelMaintenanceSettings() {
  const gateway = useGateway()
  const info = usePanelStore((s) => s.info)
  const status = usePanelStore((s) => s.status)
  const task = usePanelStore((s) => s.task)
  const trackedTaskId = usePanelStore((s) => s.trackedTaskId)
  const logs = usePanelStore((s) => s.logs)
  const logOffset = usePanelStore((s) => s.offset)
  const hasMore = usePanelStore((s) => s.hasMore)
  const logViewport = useRef<HTMLDivElement>(null)
  const [retryingCLI, setRetryingCLI] = useState(false)
  const loadError = usePanelStore((s) => s.errorMessage)
  const frontendId = useId(), backendId = useId()
  const [frontend, setFrontend] = useState('')
  const [backend, setBackend] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [checking, setChecking] = useState(false)
  const channel = 'release' as const
  const [source, setSource] = useState<PanelUpdateSource>('github')
  const [update, setUpdate] = useState<PanelUpdate | null>(null)
  const checkVersion = useRef(0)
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
  const currentVersion = info ? info.releaseTag || '未记录' : status === 'error' ? '读取失败' : '正在读取…'
  const buildTime = formatDateTimeWithYear(info?.buildTime)
  const checkedUpdate = update?.channel === channel && update.source === source ? update : null
  const hasAvailableUpdate = checkedUpdate?.available === true
  const sourceUrl = source === 'gitee' ? 'https://gitee.com/Chentyit/Elysian' : 'https://github.com/Tianyi822/Elysian'
  const sourceLinkLabel = `打开 ${PANEL_UPDATE_SOURCE_LABELS[source]} 仓库`
  useFeedbackMessage(loadError ? `面板配置读取失败：${loadError}` : null)
  useFeedbackMessage(info && !info.available ? `面板维护不可用：${info.reason}` : null, 'warning')
  useFeedbackMessage(task?.state === 'succeeded' && (task.kind !== 'update' || verifiedUpdate === task.id) ? '面板维护已完成' : null, 'success')

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
    if (!usePanelStore.getState().info) void usePanelStore.getState().load(gateway, { preserveTask: true })
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
    catch (cause) { if (current()) setProgressError(messageOf(cause, 'CLI 注册重试失败')) }
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
      const message = messageOf(cause, '维护请求失败，请重试')
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
  const { guardProps: portsGuardProps, isImeKey: portsImeKey } = useImeEnterGuard()
  const onPorts = (event: FormEvent) => {
    event.preventDefault()
    if (portsImeKey()) return
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
      const result = await gateway.panel.checkUpdate(channel, source)
      if (current()) setUpdate(result)
    }
    catch (cause) { if (current()) setUpdateError(messageOf(cause, '检查更新失败，请重试')) }
    finally { if (current()) setChecking(false) }
  }
  const selectSource = (next: PanelUpdateSource) => {
    if (source === next) return
    checkVersion.current += 1
    setSource(next); setUpdate(null); setResourceTarget(null); setChecking(false); setUpdateError(null)
  }
  const beginUpdate = () => {
    if (!checkedUpdate?.available || unavailable || checking) return
    const { channel, source, targetCommit, releaseTag } = checkedUpdate
    const target = { channel, source, targetCommit, releaseTag }
    if (info?.resourcePreflightVersion) setResourceTarget(target)
    else void submit(`update:${target.source}:${target.channel}:${target.releaseTag}:${target.targetCommit}`, { kind: 'update', input: target })
  }
  return <>
    <section aria-label="面板端口" className="panel-surface p-5">
      <div className="flex items-center gap-1.5"><h2 className="text-sm font-medium text-fg">面板端口</h2><SectionHelp label="面板端口说明">前端端口用于打开面板，后端端口供面板内部使用。保存后会重启，页面会短暂断开。</SectionHelp></div>
      {(status === 'idle' || status === 'loading') && !loadError ? <p role="status" className="mt-3 text-xs text-fg-muted">正在读取面板配置…</p> : null}
      {loadError ? <div className="mt-3"><p role="alert" className="text-xs text-danger">{loadError}</p><Button variant="outline" type="submit" className={`${BUTTON} mt-3`} onClick={() => void usePanelStore.getState().load(gateway)}>重新读取配置</Button></div> : null}
      {info && !info.available ? <p role="status" className="mt-3 text-xs leading-5 text-fg-muted">{info.reason}</p> : null}
      <form onSubmit={onPorts} {...portsGuardProps} className="mt-5 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div><label htmlFor={frontendId} className="mb-2 block text-xs font-medium text-fg">前端端口</label><input id={frontendId} inputMode="numeric" value={frontend} onChange={(e) => { setFrontend(e.target.value); setPortsError(null) }} disabled={unavailable} className={INPUT} /></div>
          <div><label htmlFor={backendId} className="mb-2 block text-xs font-medium text-fg">后端端口</label><input id={backendId} inputMode="numeric" value={backend} onChange={(e) => { setBackend(e.target.value); setPortsError(null) }} disabled={unavailable} className={INPUT} /></div>
        </div>
        {portsError ? <p role="alert" className="break-all text-xs leading-5 text-danger">{portsError}</p> : null}
        <div className="flex flex-wrap gap-2"><Button variant="outline" type="submit" disabled={unavailable} className={BUTTON}>{submitting ? '正在提交…' : '保存并重启'}</Button><Button variant="outline" type="button" disabled={unavailable} className={BUTTON} onClick={() => void submit('restart', { kind: 'restart', input: null })}>{submitting ? '正在提交…' : '重启面板'}</Button></div>
      </form>
    </section>
    <section aria-label="面板更新" className="panel-surface p-5">
      <div className="flex items-center gap-1.5"><h2 className="text-sm font-medium text-fg">面板更新</h2><SectionHelp label="面板更新说明">{info?.updateDelivery === 'precompiled/v1' ? '从所选平台下载并校验预编译安装包，准备完成后短暂重启。服务器无需 Go 或 Bun，不提前停止其他业务；更新失败会恢复原版本并保留数据。' : '先下载并编译新版本，成功后重启。更新失败会恢复原版本，保留面板数据。资源不足时，先确认停机清单；提前停止面板后，构建期间页面暂时不可访问。'}</SectionHelp></div>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-fg-muted">
          <span>当前版本</span>
          <span className="min-w-0 wrap-anywhere text-lg font-semibold tabular-nums text-fg">{currentVersion}</span>
        </p>
        <div role="status" className="min-w-0 empty:sr-only">
          {checkedUpdate ? (
            <Badge
              dot
              animateChanges={false}
              tone={hasAvailableUpdate ? 'info' : checkedUpdate.releaseTag ? 'success' : 'neutral'}
              className="h-auto min-h-6 max-w-full wrap-anywhere whitespace-normal py-0.5"
            >
              {updateStatusLabel(checkedUpdate, info?.releaseTag)}
            </Badge>
          ) : null}
        </div>
      </div>
      {buildTime ? (
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs leading-5 text-fg-muted">
          <span>构建时间</span>
          <time dateTime={info?.buildTime} className="tabular-nums">{buildTime} 北京时间</time>
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ChipGroup
          ariaLabel="更新来源"
          items={(['github', 'gitee'] as const).map((value) => ({ value, label: PANEL_UPDATE_SOURCE_LABELS[value] }))}
          value={source}
          onSelect={selectSource}
          disabled={active || submitting || pending !== null}
        />
        <IconButton asChild label={sourceLinkLabel}>
          <a
            aria-label={sourceLinkLabel}
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="icon-button inline-flex size-8 shrink-0 items-center justify-center text-fg-muted hover:bg-surface-raised hover:text-fg"
          >
            <ExternalLink aria-hidden size={16} />
          </a>
        </IconButton>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {hasAvailableUpdate ? (
          <Button type="button" className={BUTTON} disabled={unavailable || checking} onClick={beginUpdate}>
            {submitting ? '正在提交…' : '更新并重启'}
          </Button>
        ) : null}
        <Button variant={hasAvailableUpdate ? 'outline' : 'primary'} type="button" className={BUTTON} disabled={unavailable} isLoading={checking} loadingText="正在检查…" onClick={() => void check()}>
          检查更新
        </Button>
        <PanelChangelogDialog source={source} channel={channel} currentCommit={info?.commit ?? ''}>
          <Button variant="outline" type="button" className={BUTTON} disabled={!info?.available} title={info && !info.available ? info.reason : undefined}>
            更新日志
          </Button>
        </PanelChangelogDialog>
      </div>
      {info?.available && !info.resourcePreflightVersion ? <p className="mt-2 text-xs leading-5 text-warning">当前服务器版本不支持更新资源预检。首次升级前请手动释放负载；不会自动停止其他业务。</p> : null}
      {updateError || verificationError ? <p role="alert" className="mt-3 break-all text-xs leading-5 text-danger">{updateError ?? verificationError}</p> : null}
    </section>
    {pending ? <section aria-label="维护提交结果" className="panel-surface p-5">
      <p role="status" className="text-xs leading-5 text-warning">{submitting ? '正在提交维护请求…' : '提交结果未确认，正在按请求编号核对。'}</p>
      <p className="mt-2 break-all text-xs text-fg-muted">请求编号：{pending.requestId}</p>
      {progressError ? <p role="alert" className="mt-2 text-xs text-danger">{progressError}</p> : null}
      <Button variant="outline" type="submit" className={`${BUTTON} mt-3`} disabled={submitting} onClick={() => void submit(pending.kind, { kind: pending.kind, input: pending.input }, pending)}>重试原维护请求</Button>
    </section> : null}
    {task && !updateCompleted ? <section aria-label="面板维护进度" className="panel-surface p-5">
      <h2 className="text-sm font-medium text-fg">面板维护进度</h2>
      <p role="status" className="mt-3 text-xs leading-5 text-fg">{task.state === 'succeeded' && task.kind === 'update' && trackedTaskId === task.id && verifiedUpdate !== task.id ? '运行版本待确认' : PANEL_TASK_STATE_LABELS[task.state]} · {panelMaintenancePhaseLabel(task)}</p>
      <PanelMaintenanceProgress task={task} logs={logs} paused={Boolean(progressError || connectionError)} />
      {panelTaskIsActive(task) && task.workerDead ? <p role="status" className="mt-2 break-all text-xs leading-5 text-warning">维护进程已退出但任务尚未判定结果，等待服务器自动收敛；若长时间无变化，请在服务器执行 journalctl -u elysian-maintenance-{task.id} 查看现场。</p> : null}
      {task.state === 'succeeded' && task.cliRegistration?.status === 'pending' ? <p role="status" className="mt-2 text-xs text-warning">面板升级成功，正在完成 CLI 注册…</p> : null}
      {task.state === 'succeeded' && task.cliRegistration?.status === 'failed' ? <div className="mt-3 space-y-2"><p role="alert" className="break-all text-xs text-danger">面板升级成功、CLI 注册失败：{task.cliRegistration.error}</p><Button variant="outline" type="submit" className={BUTTON} disabled={retryingCLI || active || submitting} onClick={() => void retryCLI()}>{retryingCLI ? '正在重试…' : '重试 CLI 注册'}</Button></div> : null}
      {task.cliRegistration?.status === 'succeeded' ? <p role="status" className="mt-2 text-xs text-success">CLI 命令 ely 已注册</p> : null}
      {task.error && !isMaintenanceErrorLogged(logs, task.error) ? <p role="alert" className="mt-2 break-all text-xs leading-5 text-danger">{task.error}</p> : null}
      {progressError ? <p role="alert" className="mt-2 break-all text-xs leading-5 text-danger">{progressError}</p> : null}
      {connectionError ? <div className="mt-3 space-y-2">
        <p role="alert" className="break-all text-xs leading-5 text-warning">{connectionError}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" type="submit" className={BUTTON} onClick={() => { setConnectionError(null) }}>重新等待连接</Button>
          {task.kind !== 'ports' ? <Button variant="outline" type="submit" className={BUTTON} onClick={() => reloadPanelPage()}>重新加载面板</Button> : null}
        </div>
      </div> : null}
      {task.kind !== 'ports' && needsManualReload ? <Button variant="outline" type="submit" className={`${BUTTON} mt-3`} onClick={() => reloadPanelPage()}>重新加载面板</Button> : null}
      {task.kind === 'ports' ? <div className="mt-3 flex flex-col gap-2 break-all text-xs"><a className="text-fg underline underline-offset-4" href={panelAddress(task.newPorts.frontendPort)}>打开新地址：{panelAddress(task.newPorts.frontendPort)}</a><a className="text-fg-muted underline underline-offset-4" href={panelAddress(task.oldPorts.frontendPort)}>打开原地址：{panelAddress(task.oldPorts.frontendPort)}</a></div> : null}
      {logs ? <PanelMaintenanceLog logs={logs} viewportRef={logViewport} /> : null}
      {hasMore ? <p role="status" className="mt-3 text-xs text-fg-muted">正在读取最新日志…</p> : null}
    </section> : null}
    {resourceTarget ? <PanelResourcePreflightDialog target={resourceTarget} adapter={gateway.panel} precompiled={info?.updateDelivery === 'precompiled/v1'} onClose={() => setResourceTarget(null)} onConfirm={resourcePlan => {
      const target = { ...resourceTarget, resourcePlan }
      setResourceTarget(null)
      void submit(`update:${target.source}:${target.channel}:${target.releaseTag}:${target.targetCommit}:${JSON.stringify(resourcePlan)}`, { kind: 'update', input: target })
    }} /> : null}
  </>
}
