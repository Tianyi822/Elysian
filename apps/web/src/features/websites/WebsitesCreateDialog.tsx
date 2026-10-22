import { deploymentTaskSummary } from './deploymentTaskSummary'
import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import { WEBSITE_PROJECT_KIND_LABELS, isValidWebsiteProjectName, isValidWebsitePort, isValidWebsiteDomain, parseProjectNameFromGitUrl, websiteDeploymentIsActive } from '@elysian/contracts'
import type { WebsiteSource, WebsiteBuildConfig, WebsiteDeploymentTask, WebsiteProject, WebsiteRuntimeCatalogReport } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useWebsitesStore } from '../../stores/websitesStore'
import { useWebsiteDeploymentsStore } from '../../stores/websiteDeploymentsStore'
import { accessConfigEntryVisible, useDependencyProbeStore } from '../../stores/dependencyProbeStore'
import { IconButton } from '../../components/IconButton'
import { SelectDropdown } from '../../components/SelectDropdown'
import { X } from '../../components/icons'
import { FORM_CONTROL_HEIGHT_CLASS } from '../../components/formControl'
import { useFeedbackNotification } from '../../components/useFeedbackNotification'
import { useNotificationStore } from '../../stores/notificationStore'

const INPUT = `${FORM_CONTROL_HEIGHT_CLASS} w-full rounded-lg border border-control-line bg-surface-raised px-2.5 text-sm text-fg placeholder:text-fg-subtle disabled:opacity-60`
const BUTTON = 'rounded-lg border border-control-line bg-surface-raised px-3 py-2 text-xs font-medium text-fg hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'
const TOOL_LABEL: Record<string, string> = { javac: '普通 Java · JDK', maven: 'Maven', gradle: 'Gradle', npm: 'npm', pnpm: 'pnpm', yarn: 'Yarn', bun: 'Bun', go: 'Go Modules', pip: 'Python / pip', uv: 'Python / uv', poetry: 'Python / Poetry', static: '静态目录', artifact: '已构建产物' }
const TEST_LABEL = { pending: '等待测试', passed: '测试与检查已通过', failed: '测试或构建未完成，请查看日志', absent: '未发现测试', skipped: '已明确跳过测试' }
const TOOL_DEFAULT: Record<string, string> = { maven: '3.9.11', gradle: '8.14.3', pnpm: '10.17.1', yarn: '1.22.22', bun: '1.2.22', uv: '0.8.22', poetry: '2.2.1' }
const initialConfig: WebsiteBuildConfig = { candidateId: '', target: 'service', command: '', skipTests: false }
function errorOf(error: unknown) { return error instanceof Error ? error.message : '部署操作失败' }
function configurationWarning(source: WebsiteSource | undefined, candidateId: string) {
  const warnings = [...(source?.report?.warnings ?? []), ...(source?.report?.candidates.find((candidate) => candidate.id === candidateId)?.warnings ?? [])]
  return [...new Set(warnings)].join('\n')
}

/** 三步部署；来源与任务存在服务端，关闭弹窗后可从部署任务入口恢复。 */
export function WebsitesCreateDialog({ project, existingTask, onClose }: { project?: WebsiteProject; existingTask?: WebsiteDeploymentTask; onClose?: () => void } = {}) {
  const gateway = useGateway()
  const api = gateway.websites.deployment
  const caddyReady = useDependencyProbeStore((s) => accessConfigEntryVisible(s.report, s.status))
  const close = onClose ?? useWebsitesStore.getState().closeCreate
  const [step, setStep] = useState(1)
  const [sourceType, setSourceType] = useState<'archive' | 'git'>('archive')
  const [mode, setMode] = useState<'source' | 'artifact'>('source')
  const [file, setFile] = useState<File>()
  const [url, setUrl] = useState(project?.gitUrl ?? '')
  const [gitRef, setGitRef] = useState('')
  const [token, setToken] = useState('')
  const [source, setSource] = useState<WebsiteSource>()
  const [config, setConfig] = useState<WebsiteBuildConfig>(existingTask?.config ?? initialConfig)
  const [catalog, setCatalog] = useState<WebsiteRuntimeCatalogReport>()
  const [catalogError, setCatalogError] = useState<string>()
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogAttempt, setCatalogAttempt] = useState(0)
  const [name, setName] = useState(project?.name ?? '')
  const [port, setPort] = useState(project?.port ?? existingTask?.port ?? 8080)
  const [note, setNote] = useState(project?.note ?? '')
  const [accessMode, setAccessMode] = useState<'direct' | 'domain'>(project?.accessMode ?? 'direct')
  const [domain, setDomain] = useState(project?.domain ?? '')
  const [certificate, setCertificate] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [customTests, setCustomTests] = useState('')
  const [customBuild, setCustomBuild] = useState('')
  const [task, setTask] = useState<WebsiteDeploymentTask | undefined>(existingTask)
  const [logs, setLogs] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const abort = useRef<AbortController | null>(null)
  const offset = useRef(0)
  const completed = useRef(false)
  const candidate = source?.report?.candidates.find((entry) => entry.id === config.candidateId)
  const runtimeKind = candidate?.kind === 'html' ? undefined : candidate?.kind
  const entries = runtimeKind ? catalog?.catalog[runtimeKind] ?? [] : []
  const finalAccessMode = project ? project.accessMode : caddyReady ? accessMode : 'direct'
  useFeedbackNotification(error)
  useFeedbackNotification(catalogError)
  useFeedbackNotification(configurationWarning(source, config.candidateId), 'warning')
  useFeedbackNotification(catalog?.stale ? catalog.detail || '使用已获取的版本目录缓存' : null, 'warning')

  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    setCatalogLoading(true)
    void gateway.websites.runtimeCatalog(controller.signal).then((report) => { if (!controller.signal.aborted) { setCatalog(report); setCatalogError(undefined) } }).catch((e: unknown) => { if (!controller.signal.aborted) setCatalogError(errorOf(e)) }).finally(() => { if (!controller.signal.aborted) setCatalogLoading(false) })
    return () => controller.abort()
  }, [gateway, catalogAttempt])
  useEffect(() => {
    if (!existingTask || !api) return
    setTask(existingTask); setStep(3); setName(existingTask.name)
    void api.source(existingTask.sourceId).then(setSource).catch(() => {})
  }, [existingTask, api])
  useEffect(() => {
    if (!candidate) return
    setConfig((previous) => ({ ...previous, buildVersion: previous.buildVersion || entries[0]?.version, runtimeVersion: previous.runtimeVersion || project?.runtimeVersion || entries[0]?.version }))
  }, [candidate?.id, catalog, project?.runtimeVersion]) // 版本目录回填，不回填启动命令
  useEffect(() => {
    if (step !== 3 || !task?.id || !api) return
    let stopped = false; let inFlight = false; let timer: number | undefined
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const [latest, batch] = await Promise.all([api.task(task.id), api.logs(task.id, offset.current)])
        if (stopped) return
        setTask(latest); useWebsiteDeploymentsStore.getState().put(latest)
        if (batch.next > offset.current) { setLogs((text) => (text + batch.lines.join('')).slice(-128_000)); offset.current = batch.next }
        if (!websiteDeploymentIsActive(latest.state) && latest.state !== 'awaiting-config' && batch.next >= batch.total && timer !== undefined) window.clearInterval(timer)
        if (!websiteDeploymentIsActive(latest.state) && latest.state !== 'awaiting-config' && !completed.current) { completed.current = true; void useWebsitesStore.getState().refresh(gateway) }
      } catch (e) { if (!stopped) setError(errorOf(e)) } finally { inFlight = false }
    }
    void poll(); timer = window.setInterval(() => void poll(), 2000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [step, task?.id, api, gateway])

  const patch = (values: Partial<WebsiteBuildConfig>) => setConfig((old) => ({ ...old, ...values }))
  const chooseCandidate = (id: string, prepared = source) => {
    const c = prepared?.report?.candidates.find((entry) => entry.id === id)
    setConfig({ candidateId: id, target: c?.kind === 'html' ? 'static' : 'service', command: '', skipTests: false, entry: c?.entries.length === 1 ? c.entries[0] : '', toolVersion: c?.toolVersion || TOOL_DEFAULT[c?.tool ?? ''] })
  }
  const acceptSource = (prepared: WebsiteSource) => {
    if (prepared.state !== 'ready' || !prepared.report) throw new Error(prepared.error || '项目来源未准备完成')
    setSource(prepared); setStep(2); setRequestId(crypto.randomUUID())
    if (!name) setName(prepared.type === 'git' ? parseProjectNameFromGitUrl(prepared.gitUrl ?? url) ?? prepared.name : prepared.name.replace(/\.(?:zip|tar\.gz)$/i, ''))
    if (prepared.report.candidates.length === 1) chooseCandidate(prepared.report.candidates[0]!.id, prepared)
  }
  const prepare = async () => {
    if (!api) { setError('部署接口尚未接入'); return }
    if (sourceType === 'archive' && !file) { setError('请选择 ZIP 或 tar.gz 压缩包'); return }
    if (file && file.size > 512 * 1024 * 1024) { setError('压缩包不能超过 512 MiB'); return }
    const controller = new AbortController(); abort.current = controller; setBusy(true); setError(undefined)
    try {
      let prepared = sourceType === 'archive' ? await api.archive(file!, mode, controller.signal) : await api.git({ url: url.trim(), ref: gitRef.trim() || undefined, token: token || undefined, mode }, controller.signal)
      setToken(''); setSource(prepared)
      while (prepared.state === 'preparing' && !controller.signal.aborted) {
        await new Promise<void>((resolve, reject) => { const cancelled = () => { clearTimeout(timer); reject(new Error('来源准备已取消')) }; const timer = window.setTimeout(() => { controller.signal.removeEventListener('abort', cancelled); resolve() }, 2000); controller.signal.addEventListener('abort', cancelled, { once: true }) })
        prepared = await api.source(prepared.id, controller.signal); setSource(prepared)
      }
      if (!controller.signal.aborted) acceptSource(prepared)
    } catch (e) { if (!controller.signal.aborted) setError(errorOf(e)) } finally { setBusy(false); abort.current = null }
  }
  const deploy = async (resume = false) => {
    if (!api || !source || !candidate) { setError('请选择识别出的项目目录'); return }
    if (!isValidWebsiteProjectName(name.trim())) { setError('项目名称需为 1-64 个字符，不能包含路径字符'); return }
    if (!isValidWebsitePort(port)) { setError('端口需为 1-65535 的整数'); return }
    if (config.target === 'service' && !config.command.trim() && !(candidate.kind === 'java' && source.mode === 'source')) { setError('请填写容器启动命令或采用建议'); return }
    if (candidate.entries.length > 1 && !config.entry) { setError('请选择项目入口'); return }
    if (!project && finalAccessMode === 'domain' && (!isValidWebsiteDomain(domain.trim()) || !certificate || !privateKey)) { setError('请填写有效域名并上传公开 CA 证书链与私钥'); return }
    const chosen = { ...config, command: config.command.trim(), ...(advanced && customTests.trim() ? { testSteps: customTests.split('\n').filter((line) => line.trim()) } : {}), ...(advanced && customBuild.trim() ? { buildSteps: customBuild.split('\n').filter((line) => line.trim()) } : {}) }
    setBusy(true); setError(undefined)
    try {
      const started = resume && task ? await api.resume(task.id, chosen) : await api.submit({ sourceId: source.id, projectId: project?.id, requestId, name: name.trim(), port, note: note.trim() || undefined, access: finalAccessMode === 'direct' ? { mode: 'direct' } : { mode: 'domain', domain: domain.trim(), certificatePem: certificate, privateKeyPem: privateKey }, config: chosen })
      setTask(started); useWebsiteDeploymentsStore.getState().put(started); setStep(3); completed.current = false
      useNotificationStore.getState().notify({ tone: 'info', message: resume ? '部署任务已继续' : `已提交项目 ${started.name} 的部署任务` })
    } catch (e) { setError(errorOf(e)) } finally { setBusy(false) }
  }
  const readCertificate = async (file: File | undefined, key: boolean) => { if (!file) return; if (file.size > 256 * 1024) { setError('证书文件不能超过 256 KiB'); return }; try { const text = await file.text(); if (key) setPrivateKey(text); else setCertificate(text) } catch (e) { setError(errorOf(e)) } }
  const closeDialog = () => { abort.current?.abort(); if (source?.state === 'preparing') void api?.discardSource(source.id).catch(() => {}); close() }
  const waiting = task?.state === 'awaiting-config'
  const configuration = step === 2 || (step === 3 && waiting)
  const label = (id: string, text: string, children: React.ReactNode) => <div className="space-y-1"><label htmlFor={id} className="block text-xs font-medium text-fg-muted">{text}</label>{children}</div>
  const runtimeSelect = (field: 'buildVersion' | 'runtimeVersion', title: string) => <div className="space-y-1"><p id={`deploy-${field}-label`} className="text-xs font-medium text-fg-muted">{title}</p><SelectDropdown ariaLabel={title} items={entries.map((entry) => ({ value: entry.version, label: entry.version }))} value={config[field] ?? ''} fallbackLabel={catalogLoading ? '正在加载版本…' : '请选择精确版本'} onSelect={(value) => patch({ [field]: value })} fullWidth disabled={busy || waiting} search={{ ariaLabel: `搜索${title}`, placeholder: '搜索版本号（包含历史补丁）' }} /></div>

  return <Dialog.Root open onOpenChange={(open) => { if (!open) closeDialog() }}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
    <Dialog.Content aria-describedby="deployment-description" onOpenAutoFocus={(event) => { event.preventDefault(); document.getElementById('deployment-description')?.focus() }} onPointerDownOutside={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()} className="fixed left-1/2 top-1/2 z-[55] flex max-h-[calc(100dvh-2rem)] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden panel-surface shadow-2xl">
      <div className="flex items-center justify-between border-b border-line px-4 py-3"><Dialog.Title className="text-sm font-medium">{existingTask ? `部署任务 · ${existingTask.name}` : project ? `重新部署 ${project.name}` : '添加项目'}</Dialog.Title><IconButton label="关闭弹窗" onPress={closeDialog}><X aria-hidden size={15} /></IconButton></div>
      <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3 text-xs" aria-label="部署步骤">{['项目来源', '识别与部署配置', '执行进度'].map((text, i) => <span key={text} aria-current={step === i + 1 ? 'step' : undefined} className={step === i + 1 ? 'font-medium text-fg' : 'text-fg-subtle'}>{i + 1}. {text}</span>)}</div>
      <div className="space-y-4 overflow-y-auto px-4 py-4">
        <Dialog.Description id="deployment-description" tabIndex={-1} className="text-xs text-fg-muted">获取项目后确认配置，测试与构建在隔离容器内执行。每个项目使用独立运行容器。</Dialog.Description>
        {step === 1 && <>
          <div role="group" aria-label="项目来源" className="flex gap-2">{(['archive', 'git'] as const).map((type) => <button key={type} type="button" aria-pressed={sourceType === type} className={BUTTON} disabled={busy} onClick={() => setSourceType(type)}>{type === 'archive' ? '上传压缩包' : 'Git 仓库'}</button>)}</div>
          {sourceType === 'archive' ? label('deploy-archive', '项目压缩包', <input id="deploy-archive" type="file" accept=".zip,.tar.gz,.tgz" disabled={busy} onChange={(e) => setFile(e.target.files?.[0])} className="block w-full text-xs text-fg-muted file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface-raised file:px-3 file:py-2 file:text-fg" />) : <>
            {label('deploy-git', 'Git 地址（HTTPS）', <input id="deploy-git" className={INPUT} value={url} disabled={busy} placeholder="https://github.com/org/repo.git" onChange={(e) => setUrl(e.target.value)} />)}
            {label('deploy-ref', '分支、标签或提交（可选）', <input id="deploy-ref" className={INPUT} value={gitRef} disabled={busy} placeholder="留空使用远端默认分支" onChange={(e) => setGitRef(e.target.value)} />)}
            {label('deploy-token', '私有仓库令牌（可选）', <input id="deploy-token" type="password" autoComplete="off" className={INPUT} value={token} disabled={busy} placeholder="仅用于本次拉取，不保存或写入日志" onChange={(e) => setToken(e.target.value)} />)}
          </>}
          <div className="space-y-2"><p className="text-xs font-medium text-fg-muted">包内容</p>{(['source', 'artifact'] as const).map((value) => <label key={value} className="mr-4 inline-flex items-center gap-2 text-xs"><input type="radio" name="deploy-mode" checked={mode === value} disabled={busy} onChange={() => setMode(value)} />{value === 'source' ? '源码（测试并构建）' : '已构建产物（跳过测试与构建）'}</label>)}</div>
          <p className="text-xs text-fg-subtle">支持 ZIP / tar.gz，默认上限 512 MiB；展开上限 2 GiB、10 万条目。来源保留 24 小时。</p>
          {busy && <p role="status" className="text-xs text-fg-muted">{source?.state === 'preparing' ? '正在拉取并识别项目…' : '正在上传、解压并识别项目…'}</p>}
        </>}
        {configuration && <>
          {source?.commit && <p className="break-all text-xs text-fg-muted">已固定提交：{source.commit}</p>}
          {source?.report?.warnings.map((warning) => <p key={warning} className="text-xs text-warning">{warning}</p>)}
          <SelectDropdown ariaLabel="项目目录与构建工具" items={(source?.report?.candidates ?? []).map((c) => ({ value: c.id, label: `${c.directory} · ${WEBSITE_PROJECT_KIND_LABELS[c.kind]} · ${TOOL_LABEL[c.tool]}` }))} value={config.candidateId} fallbackLabel="请选择项目目录与构建工具" onSelect={chooseCandidate} fullWidth disabled={busy || waiting} />
          {candidate && <>
            {candidate.warnings.map((warning) => <p key={warning} className="text-xs text-warning">{warning}</p>)}
            {label('deploy-name', '项目名称 *', <input id="deploy-name" className={INPUT} value={name} disabled={busy || !!project || waiting} onChange={(e) => setName(e.target.value)} placeholder="如 订单中心-api" />)}
            {runtimeKind && source?.mode === 'source' && runtimeSelect('buildVersion', candidate.kind === 'java' ? '构建 JDK 版本' : '构建运行时版本')}
            {(candidate.kind === 'node' || candidate.kind === 'html') && <SelectDropdown ariaLabel="部署目标" items={candidate.kind === 'html' ? [{ value: 'static', label: 'Nginx 静态站点' }] : [{ value: 'service', label: 'Node 服务' }, { value: 'static', label: 'Nginx 静态站点' }]} value={config.target} onSelect={(target) => patch({ target, artifact: '' })} fullWidth disabled={busy || waiting} />}
            {runtimeKind && config.target === 'service' && runtimeSelect('runtimeVersion', candidate.kind === 'java' ? '运行 JRE 版本' : '运行时版本')}
            {config.target === 'static' && <p className="text-xs text-fg-muted">运行环境：固定官方 Nginx；构建版本单独记录。</p>}
            {candidate.requiredVersion && <p className="text-xs text-fg-muted">项目声明版本要求：{candidate.requiredVersion}</p>}
            {candidate.entries.length > 0 ? <SelectDropdown ariaLabel="项目入口或主类" items={candidate.entries.map((entry) => ({ value: entry, label: entry }))} value={config.entry ?? ''} fallbackLabel="请选择入口（多个入口必须选择）" onSelect={(entry) => patch({ entry })} fullWidth disabled={busy} /> : label('deploy-entry', candidate.kind === 'java' ? '主类（非可执行 JAR 必填）' : '项目入口（可选）', <input id="deploy-entry" className={INPUT} value={config.entry ?? ''} disabled={busy} onChange={(e) => patch({ entry: e.target.value })} placeholder={candidate.kind === 'java' ? '如 com.example.Main' : '无法自动识别时补充入口'} />)}
            {source?.mode === 'source' && <div className="rounded-lg border border-line p-3 text-xs"><p>测试：{candidate.testSteps.length ? candidate.testSteps.join(' → ') : '未发现测试'}</p><p className="mt-2">构建：{candidate.buildSteps.join(' → ') || '无需构建'}</p><p className="mt-2">构建工具：{TOOL_LABEL[candidate.tool]}{candidate.wrapper ? ' · 项目 Wrapper' : ''}{config.toolVersion ? ` ${config.toolVersion}` : ''}</p></div>}
            {task?.artifacts && task.artifacts.length > 0 ? <SelectDropdown ariaLabel="部署产物" items={task.artifacts.map((artifact) => ({ value: artifact, label: artifact }))} value={config.artifact ?? ''} fallbackLabel="请选择构建产物" onSelect={(artifact) => patch({ artifact })} fullWidth disabled={busy} /> : label('deploy-artifact', '产物位置（可选）', <input id="deploy-artifact" className={INPUT} value={config.artifact ?? ''} onChange={(e) => patch({ artifact: e.target.value })} placeholder={candidate.artifacts.join(' / ') || '自动查找；多产物时暂停等待选择'} disabled={busy} />)}
            {label('deploy-port', '端口 *', <input id="deploy-port" className={INPUT} inputMode="numeric" value={port} disabled={busy || !!project || waiting} onChange={(e) => setPort(Number(e.target.value.replace(/\D/g, '')))} />)}
            {config.target === 'service' && <>
              {label('deploy-command', '启动命令 *', <input id="deploy-command" className={INPUT} value={config.command} disabled={busy} placeholder={task?.suggestedCommand || candidate.suggestedCommand || '填写项目实际启动命令；Java 可在构建后确认'} onChange={(e) => patch({ command: e.target.value })} />)}
              {(task?.suggestedCommand || candidate.suggestedCommand) && <button type="button" className={BUTTON} disabled={busy} onClick={() => patch({ command: task?.suggestedCommand || candidate.suggestedCommand })}>采用建议</button>}
              <p className="text-xs text-fg-subtle">服务需监听容器内的 0.0.0.0:{port}；启动命令作为参数执行。普通 JAR 根据清单、主类与依赖确定启动方式。</p>
            </>}
            {caddyReady && !project && !waiting && <div className="space-y-2"><SelectDropdown ariaLabel="访问方式" items={[{ value: 'direct', label: 'IP＋端口直连 · HTTP' }, { value: 'domain', label: '域名访问 · HTTPS' }]} value={accessMode} onSelect={setAccessMode} fullWidth />{finalAccessMode === 'domain' && <>{label('deploy-domain', '域名 *', <input id="deploy-domain" className={INPUT} value={domain} onChange={(e) => setDomain(e.target.value)} />)}{label('deploy-cert', '公开 CA 证书链', <input id="deploy-cert" type="file" accept=".pem,.crt" onChange={(e) => void readCertificate(e.target.files?.[0], false)} className="block w-full text-xs" />)}{label('deploy-key', '私钥', <input id="deploy-key" type="file" accept=".pem,.key" onChange={(e) => void readCertificate(e.target.files?.[0], true)} className="block w-full text-xs" />)}</>}</div>}
            {label('deploy-note', '备注（可选）', <input id="deploy-note" className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy || waiting} />)}
            {source?.mode === 'source' && candidate.kind !== 'html' && !waiting && <>
              <button type="button" className="text-xs text-fg-muted underline underline-offset-4" aria-expanded={advanced} onClick={() => setAdvanced((old) => !old)}>高级构建配置</button>
              {advanced && <div className="space-y-3"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={config.skipTests} onChange={(e) => patch({ skipTests: e.target.checked })} />明确跳过测试（将记录跳过原因）</label>{!candidate.wrapper && TOOL_DEFAULT[candidate.tool] && label('deploy-tool', '构建工具精确版本', <input id="deploy-tool" className={INPUT} value={config.toolVersion ?? ''} onChange={(e) => patch({ toolVersion: e.target.value })} />)}{label('deploy-tests', '自定义测试步骤（每行一个命令）', <textarea id="deploy-tests" className={`${INPUT} min-h-20 resize-none py-2`} value={customTests} onChange={(e) => setCustomTests(e.target.value)} placeholder="留空使用识别出的测试" />)}{label('deploy-build', '自定义构建步骤（每行一个命令）', <textarea id="deploy-build" className={`${INPUT} min-h-20 resize-none py-2`} value={customBuild} onChange={(e) => setCustomBuild(e.target.value)} placeholder="留空使用识别出的构建步骤" />)}<p className="text-xs text-fg-subtle">步骤只在该任务的非特权构建容器内执行；默认 2 CPU / 2 GiB，20 分钟超时。</p></div>}
            </>}
          </>}
        </>}
        {step === 3 && task && <>
          <p role="status" className="text-sm font-medium">{deploymentTaskSummary(task)}</p>
          <p className="text-xs text-fg-muted">{TEST_LABEL[task.testResult]}</p>
          {task.buildImage && <p className="break-all text-xs text-fg-muted">构建镜像：{task.buildImage}</p>}
          {task.runtimeImage && <p className="break-all text-xs text-fg-muted">运行镜像：{task.runtimeImage}</p>}
          {task.error && <p role="alert" className="text-xs text-danger">{task.error}</p>}
          {waiting && task.artifacts?.length === 0 && <p className="text-xs text-warning">未找到产物，请填写工作区内的产物路径。</p>}
          <pre role="log" aria-label="部署日志" tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-surface p-3 font-mono text-xs text-fg-muted">{logs || '等待任务日志…'}</pre>
          <p className="text-xs text-fg-subtle">任务记录与日志保留 30 天。关闭窗口后，可从「部署任务」重新进入；页面刷新不会重新提交任务。</p>
        </>}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        {configuration && catalog?.stale && <p role="status" className="text-xs text-warning">{catalog.detail || '使用已获取的版本目录缓存'}</p>}
        {configuration && runtimeKind && catalogError && <div role="alert" className="text-xs text-danger">{catalogError}<button type="button" className={`${BUTTON} ml-2`} onClick={() => setCatalogAttempt((old) => old + 1)}>重试版本目录</button></div>}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">
        {step === 1 && busy ? <button type="button" className={BUTTON} onClick={() => { abort.current?.abort(); if (source?.id) void api?.discardSource(source.id).catch(() => {}) }}>取消准备</button> : <button type="button" className={BUTTON} onClick={closeDialog}>{step === 3 && websiteDeploymentIsActive(task?.state ?? 'failed') ? '关闭，后台继续' : '关闭'}</button>}
        {step === 1 && <button type="button" className={BUTTON} disabled={busy || !api} onClick={() => void prepare()}>{busy ? '准备中…' : '获取并识别'}</button>}
        {step === 2 && <><button type="button" className={BUTTON} disabled={busy} onClick={() => setStep(1)}>返回来源</button><button type="button" className={BUTTON} disabled={busy || !candidate || (runtimeKind !== undefined && !(source?.mode === 'artifact' && config.target === 'static') && !catalog)} onClick={() => void deploy()}>{busy ? '正在提交…' : source?.mode === 'artifact' ? '部署并启动' : '构建并部署'}</button></>}
        {step === 3 && waiting && <button type="button" className={BUTTON} disabled={busy} onClick={() => void deploy(true)}>确认并继续部署</button>}
        {step === 3 && task && (websiteDeploymentIsActive(task.state) || waiting) && <button type="button" className={BUTTON} onClick={() => void api?.cancel(task.id).catch((e: unknown) => setError(errorOf(e)))}>取消任务</button>}
        {step === 3 && task && ['failed', 'cancelled', 'interrupted'].includes(task.state) && source?.state === 'ready' && <button type="button" className={BUTTON} onClick={() => { setStep(2); setRequestId(crypto.randomUUID()); setConfig(task.config); setTask(undefined); setLogs(''); offset.current = 0 }}>重新配置并部署</button>}
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
