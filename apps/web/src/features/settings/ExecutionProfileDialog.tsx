import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { AgentExecutionProfile, AgentExecutionProfileInput, ContainerImage } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { EXECUTION_IMAGE_PATTERN, validateExecutionProfile, type ExecutionFieldErrors } from '../../adapters/agentExecutionValidation'
import { useAgentExecutionStore, type ExecutionSaveResult } from '../../stores/agentExecutionStore'
import { useContainersStore } from '../../stores/containersStore'
import { CTL_FIELD, CTL_SECONDARY } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { RefreshButton } from '../../components/RefreshState'
import { Plus, Trash2 } from '../../components/icons'
import { ExtensionDialog, ExtensionToggle, IconAction } from './extensionUi'
import { ExecutionField, ExecutionFooter, ExecutionSaveNotice, useExecutionFields } from './executionUi'

const runtimes = [{ value: 'bash', label: 'Bash' }, { value: 'python', label: 'Python' }, { value: 'node', label: 'Node' }] as const
const interpreter = (runtime: AgentExecutionProfile['runtime']) => runtime === 'python' ? 'python3' : runtime

export function ExecutionProfileDialog({ profile, visible, onClose }: { profile?: AgentExecutionProfile; visible: boolean; onClose(): void }) {
  const gateway = useGateway()
  const [name, setName] = useState(profile?.name ?? '')
  const [runtime, setRuntime] = useState<AgentExecutionProfile['runtime']>(profile?.runtime ?? 'bash')
  const [image, setImage] = useState(profile?.image ?? '')
  const [command, setCommand] = useState<string[]>(profile ? [...profile.command] : ['bash'])
  const customCommand = useRef(!!profile && JSON.stringify(profile.command) !== JSON.stringify([interpreter(profile.runtime)]))
  const [timeout, setTimeout] = useState(String(profile?.timeoutSeconds ?? 60))
  const [cpu, setCPU] = useState(String((profile?.cpuMillis ?? 500) / 1000))
  const [memory, setMemory] = useState(String((profile?.memoryBytes ?? 256 * 1048576) / 1048576))
  const [pids, setPids] = useState(String(profile?.pids ?? 64))
  const [enabled, setEnabled] = useState(profile?.enabled ?? true)
  const [disableConfirmed, setDisableConfirmed] = useState(false)
  const [revision, setRevision] = useState(profile?.revision ?? 0)
  const [errors, setErrors] = useState<ExecutionFieldErrors>({})
  const [result, setResult] = useState<ExecutionSaveResult>()
  const [saving, setSaving] = useState(false)
  const [images, setImages] = useState<readonly ContainerImage[]>([])
  const [imageError, setImageError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const lifetime = useRef(0)
  const form = useId(), field = useExecutionFields(errors)
  const reloadImages = async () => {
    const owner = ++lifetime.current, auth = captureAuthGeneration()
    setLoading(true); setImageError(undefined)
    try { const items = await gateway.containers.listImages(); if (owner === lifetime.current && auth === captureAuthGeneration()) setImages(items) }
    catch (cause) { if (owner === lifetime.current && auth === captureAuthGeneration()) setImageError(cause instanceof Error ? cause.message : '本机镜像读取失败，可手填摘要地址。') }
    finally { if (owner === lifetime.current && auth === captureAuthGeneration()) setLoading(false) }
  }
  useEffect(() => { void reloadImages(); return () => { lifetime.current += 1 } }, [gateway])
  const submit = async () => {
    if (saving || result?.status === 'unknown') return
    const input: AgentExecutionProfileInput = { name: name.trim(), runtime, image, command, enabled, expectedRevision: revision, timeoutSeconds: Number(timeout), cpuMillis: Number(cpu) * 1000, memoryBytes: Number(memory) * 1048576, pids: Number(pids) }
    const nextErrors = validateExecutionProfile(input)
    if (profile?.enabled && !enabled && !disableConfirmed) nextErrors.enabled = '请确认停用对后续操作的影响。'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    const owner = lifetime.current, auth = captureAuthGeneration()
    setSaving(true)
    const next = await useAgentExecutionStore.getState().saveProfile(gateway, input, profile?.id)
    if (owner !== lifetime.current || auth !== captureAuthGeneration() || next.status === 'stale') return
    setSaving(false)
    if (next.status === 'saved') onClose(); else setResult(next)
  }
  const chooseRuntime = (value: AgentExecutionProfile['runtime']) => { setRuntime(value); if (!customCommand.current) setCommand([interpreter(value)]) }
  const fields = [
    { key: 'timeoutSeconds', label: '超时时间（秒）', value: timeout, set: setTimeout, max: 300, step: 1 },
    { key: 'cpuMillis', label: 'CPU（核）', value: cpu, set: setCPU, max: 1, step: 0.001 },
    { key: 'memoryBytes', label: '内存（MiB）', value: memory, set: setMemory, max: 512, step: 1 },
    { key: 'pids', label: '最大进程数', value: pids, set: setPids, max: 128, step: 1 },
  ]
  return <ExtensionDialog title={profile ? '编辑执行配置' : '新建执行配置'} open={visible} onClose={() => { if (!saving) onClose() }}
    footer={<ExecutionFooter form={form} saving={saving} unknown={result?.status === 'unknown'} onClose={onClose} />}>
    <form id={form} noValidate onSubmit={event => { event.preventDefault(); void submit() }} className="space-y-5">
      <fieldset disabled={saving} className="min-w-0 space-y-5">
        <p className="text-xs leading-5 text-fg-muted">保存后在聊天的「执行范围」中选用。Bash 用于命令与工作区脚本，Python／Node 用于对应技能脚本。</p>
        <ExecutionField label="配置名称" id={field('name').id} error={errors.name}><input {...field('name')} className={`${CTL_FIELD} w-full`} value={name} onChange={e => setName(e.target.value)} /></ExecutionField>
        <ExecutionField label="运行类型" id={field('runtime').id} error={errors.runtime}><SelectDropdown id={field('runtime').id} ariaLabel="运行类型" items={runtimes} value={runtime} onSelect={chooseRuntime} fullWidth /></ExecutionField>
        <section className="space-y-2" aria-label="执行镜像">
          <div className="flex items-center justify-between gap-3"><h3 className="text-xs font-medium">本机已拉取镜像</h3><RefreshButton label="刷新本机镜像" busy={loading} onPress={() => void reloadImages()} /></div>
          <div className="hover-scrollbar max-h-40 overflow-y-auto rounded-lg border border-line p-2">
            {!images.length && <p className="p-1 text-xs text-fg-muted">{loading ? '正在读取本机镜像…' : '没有可选择的本机镜像。'}</p>}
            {images.map(item => { const valid = EXECUTION_IMAGE_PATTERN.test(item.digest); return <button key={item.id} type="button" disabled={!valid} aria-pressed={valid && image === item.digest} onClick={() => setImage(item.digest)} className="block w-full rounded-md p-2 text-left text-xs hover:bg-surface-raised aria-pressed:bg-surface-raised disabled:cursor-not-allowed disabled:text-fg-subtle">
              <span className="block break-all font-medium">{item.name}:{item.tag}</span><span className="mt-1 block break-all font-mono">{valid ? item.digest : '缺少完整仓库摘要，不能用作执行镜像。'}</span>
            </button> })}
          </div>
          {imageError && <p role="alert" className="text-xs text-danger">{imageError}</p>}
          <Link to="/docker" onClick={() => useContainersStore.getState().setView('images')} className="inline-block text-xs underline underline-offset-4">前往镜像页拉取镜像</Link>
        </section>
        <ExecutionField label="镜像摘要地址" id={field('image').id} error={errors.image}><input {...field('image')} className={`${CTL_FIELD} w-full font-mono text-xs`} placeholder="仓库名@sha256:完整的64位摘要" value={image} onChange={e => setImage(e.target.value)} /></ExecutionField>
        <p className="text-xs leading-5 text-fg-muted">保存仅校验配置，不拉取镜像或启动容器。实际执行仍检查 Linux 镜像、解释器与隔离要求。</p>
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">{fields.map(item => <ExecutionField key={item.key} label={item.label} id={field(item.key).id} error={errors[item.key]}><input {...field(item.key)} type="number" min={item.step} max={item.max} step={item.step} className={`${CTL_FIELD} w-full tabular-nums`} value={item.value} onChange={e => item.set(e.target.value)} /></ExecutionField>)}</div>
        <details open={!!errors.command}><summary className="cursor-pointer text-xs font-medium">高级设置：命令参数</summary><div className="mt-3 space-y-2">
          {command.map((arg, index) => <div key={index} className="flex min-w-0 items-center gap-2"><input aria-label={`命令参数 ${index + 1}`} aria-invalid={!!errors.command} className={`${CTL_FIELD} min-w-0 flex-1 font-mono text-xs`} value={arg} onChange={e => { customCommand.current = true; setCommand(command.map((value, i) => i === index ? e.target.value : value)) }} /><IconAction label={`删除命令参数 ${index + 1}`} onClick={() => { customCommand.current = true; setCommand(command.filter((_, i) => i !== index)) }}><Trash2 size={14} aria-hidden /></IconAction></div>)}
          <button type="button" className={CTL_SECONDARY} disabled={command.length >= 64} onClick={() => { customCommand.current = true; setCommand([...command, '']) }}><Plus size={14} aria-hidden />添加参数</button>
          {errors.command && <p role="alert" className="text-xs text-danger">{errors.command}</p>}
        </div></details>
        <ExtensionToggle label="启用此执行配置" checked={enabled} onChange={setEnabled} />
        {profile?.enabled && !enabled && <div className="space-y-2 text-xs"><label className="flex items-start gap-2"><input type="checkbox" checked={disableConfirmed} onChange={event => setDisableConfirmed(event.target.checked)} /><span>确认停用：阻止后续使用并保留历史，不保证停止已派发的操作。</span></label>{errors.enabled && <p role="alert" className="text-danger">{errors.enabled}</p>}</div>}
      </fieldset>
      <ExecutionSaveNotice result={result} revision={revision} onRevision={setRevision} onAcknowledge={() => setResult(current => current ? { ...current, status: 'error', message: undefined } : undefined)} />
    </form>
  </ExtensionDialog>
}
