import { useEffect, useEffectEvent, useState } from 'react'
import type { ContainerRecreateConfig, ContainerRecreateInput, ContainerRecreateMount, ContainerRecreatePatch, ContainerRecreatePreview, ContainerRecreateTask, PortMapping } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { useContainersStore } from '../stores/containersStore'
import { useMessageStore } from '../stores/messageStore'
import { captureAuthGeneration } from '../utils/authGeneration'
import { messageOf } from '../utils/errorMessage'
import { Button } from './Button'
import { Alert, AlertDescription, AlertTitle } from './easyui/Alert'
import { CTL_FIELD } from './formControl'
import { SelectDropdown } from './SelectDropdown'
import { ToggleSwitch } from './ToggleSwitch'

const inputClass = `${CTL_FIELD} min-w-0 w-full`
const groupClass = 'min-w-0 space-y-2 rounded-xl border border-line p-3'
const taskLabels = { running: '正在重建', succeeded: '重建完成', failed: '重建未完成', unknown: '等待核实' } as const
const stages: Record<string, string> = {
  accepted: '已受理', dispatched: '正在检查配置', 'recreate-creating': '正在创建候选容器',
  'recreate-candidate': '候选容器已创建', 'recreate-switching': '正在切换容器',
  'recreate-verifying': '正在核对运行状态', 'recreate-rolling-back': '正在恢复原容器',
}

export function ContainerRecreateStatus({ task, gateway, onChange, refresh }: {
  task: ContainerRecreateTask; gateway: ElysianGateway; onChange(task: ContainerRecreateTask): void; refresh(): void
}) {
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const commit = useEffectEvent((next: ContainerRecreateTask) => {
    onChange(next)
    if (task.state === 'running' && next.state !== 'running') {
      useMessageStore.getState().notify({ tone: next.state === 'succeeded' ? 'success' : 'warning', message: `${next.recreate.name} · ${taskLabels[next.state]}` })
      refresh()
    }
  })
  useEffect(() => {
    if (task.state !== 'running' || !gateway.containers.recreateTask) return
    const auth = captureAuthGeneration()
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await gateway.containers.recreateTask!(task.requestId, abort.signal)
        if (abort.signal.aborted || auth !== captureAuthGeneration()) return
        setError('')
        commit(next)
        if (next.state !== 'running') return
      } catch (cause) {
        if (abort.signal.aborted || auth !== captureAuthGeneration()) return
        setError(messageOf(cause, '无法读取重建任务'))
      }
      timer = setTimeout(() => { void poll() }, 1_000)
    }
    timer = setTimeout(() => { void poll() }, attempt === 0 ? 350 : 0)
    return () => { abort.abort(); clearTimeout(timer) }
  }, [task.requestId, task.state, gateway, attempt])
  const [checking, setChecking] = useState(false)
  const check = async () => {
    if (!gateway.containers.recreateTask) return
    setChecking(true)
    try {
      const next = await gateway.containers.recreateTask(task.requestId)
      onChange(next)
      if (next.state !== task.state) refresh()
    } catch (cause) { setError(messageOf(cause, '无法核实重建任务')) }
    finally { setChecking(false) }
  }
  return <Alert tone={task.state === 'succeeded' ? 'success' : task.state === 'running' ? 'info' : 'warning'} role="status">
    <AlertTitle>{taskLabels[task.state]}</AlertTitle>
    <AlertDescription className="space-y-1">
      {task.message ? <p>{task.message}</p> : task.state === 'running' ? <p>{stages[task.stage] ?? '正在执行'}</p> : null}
      {task.state === 'succeeded' && <p className="[overflow-wrap:anywhere]">原容器保留为 {task.recreate.backupName}</p>}
      {error && <p>{error} <Button variant="link" type="button" onClick={() => setAttempt(value => value + 1)}>重试</Button></p>}
      {task.state === 'unknown' && <Button variant="outline" type="button" isLoading={checking} onClick={() => void check()}>核实状态</Button>}
    </AlertDescription>
  </Alert>
}

const newPort = (): PortMapping => ({ containerPort: 0, hostPort: 0, protocol: 'tcp', hostIp: '' })
const newMount = (): ContainerRecreateMount => ({ kind: 'bind', source: '', target: '', readOnly: false })
type EnvEdit = NonNullable<ContainerRecreatePatch['env']>[number]
function newRequestId() { return [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('') }

export function ContainerRecreateEditor({ config, gateway, onClose, onTask }: {
  config: ContainerRecreateConfig; gateway: ElysianGateway; onClose(): void; onTask(task: ContainerRecreateTask): void
}) {
  const container = config.container
  const images = useContainersStore(s => s.images)
  const [image, setImage] = useState('')
  const [ports, setPorts] = useState<PortMapping[]>()
  const [mounts, setMounts] = useState<ContainerRecreateMount[]>()
  const [env, setEnv] = useState<EnvEdit[]>([])
  const [review, setReview] = useState<{ preview: ContainerRecreatePreview; input: ContainerRecreateInput }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const editPort = (index: number, change: Partial<PortMapping>) => setPorts((ports ?? [...container.ports]).map((p, i) => i === index ? { ...p, ...change } : p))
  const editMount = (index: number, change: Partial<ContainerRecreateMount>) => setMounts((mounts ?? [...config.mounts]).map((m, i) => i === index ? { ...m, ...change } : m))
  const editEnv = (index: number, change: EnvEdit) => setEnv(env.map((r, i) => i === index ? change : r))
  const preview = async () => {
    if (busy || !gateway.containers.previewRecreate) return
    const auth = captureAuthGeneration()
    setBusy(true); setError('')
    try {
      const preview = await gateway.containers.previewRecreate(container.id, { ...(image ? { imageId: image } : {}), ports, mounts, env })
      if (auth === captureAuthGeneration()) setReview({ preview, input: {
        id: preview.id, planId: preview.planId, revision: preview.revision, requestId: newRequestId(),
      } })
    } catch (cause) { setError(messageOf(cause, '无法预览重建')) }
    finally { setBusy(false) }
  }
  const submit = async () => {
    if (!review || busy || !gateway.containers.submitRecreate) return
    const auth = captureAuthGeneration()
    setBusy(true); setError('')
    try {
      const task = await gateway.containers.submitRecreate(review.input)
      if (auth === captureAuthGeneration()) { onTask(task); onClose() }
    } catch (cause) { setError(messageOf(cause, '提交结果未确认，请按原请求重试')) }
    finally { setBusy(false) }
  }
  return <div className="space-y-3 text-sm">
    <h3 className="font-semibold">{review ? '核对重建变更' : '编辑容器配置'}</h3>
    {error && <Alert tone="danger"><AlertTitle>{error}</AlertTitle></Alert>}
    {review ? <>
      <Alert tone="warning"><AlertTitle>{review.preview.running ? '切换期间服务会短暂停止' : '替换后容器保持停止'}</AlertTitle>
        <AlertDescription>
          <p>沿用启动命令。原容器停用并保留，写入层仍在原容器中。{review.preview.writableChanges !== null && `原写入层检测到 ${review.preview.writableChanges} 项变更。`}</p>
          {review.preview.healthWaitSeconds ? <p>切换后最多等待 {review.preview.healthWaitSeconds} 秒核验健康状态。</p> : null}
          {review.preview.retainedMountTargets?.length ? <p className="[overflow-wrap:anywhere]">沿用挂载 {review.preview.retainedMountTargets.join('、')}</p> : null}
        </AlertDescription>
      </Alert>
      <dl className={groupClass}>{review.preview.changes.map((change, i) => <div key={i}>
        <dt className="font-medium [overflow-wrap:anywhere]">{change.field}</dt>
        {change.before && <dd className="text-fg-muted [overflow-wrap:anywhere]">原值 {change.before}</dd>}
        {change.after && <dd className="[overflow-wrap:anywhere]">目标 {change.after}</dd>}
      </div>)}</dl>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={() => { setReview(undefined); setError('') }}>返回编辑</Button>
        <Button type="button" isLoading={busy} onClick={() => void submit()}>确认重建</Button>
      </div>
    </> : <form className="space-y-3" onSubmit={event => { event.preventDefault(); void preview() }}>
      <fieldset className={groupClass} disabled={busy}><legend>镜像</legend>
        <p>本地镜像</p>
        <SelectDropdown ariaLabel="本地镜像" fullWidth disabled={busy} value={image} onSelect={setImage}
          items={[{ value: '', label: '沿用当前镜像' }, ...images.map(item => ({ value: item.id, label: `${item.name}:${item.tag}` }))]}
          search={{ ariaLabel: '搜索本地镜像', placeholder: '搜索镜像' }} />
        <p className="text-xs text-fg-muted">如需新镜像，请先在镜像页拉取。</p>
      </fieldset>
      <fieldset className={groupClass} disabled={busy}><legend>端口映射</legend>
        {(ports ?? container.ports).map((port, i) => <div key={i} className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
          <label className="min-w-0">容器端口<input required type="number" min={1} max={65535} className={inputClass} value={port.containerPort || ''} onChange={e => editPort(i, { containerPort: Number(e.target.value) })} /></label>
          <label className="min-w-0">宿主端口<input required type="number" min={1} max={65535} className={inputClass} value={port.hostPort || ''} onChange={e => editPort(i, { hostPort: Number(e.target.value) })} /></label>
          <div className="min-w-0">协议<SelectDropdown ariaLabel="协议" fullWidth disabled={busy} value={port.protocol}
            items={[{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }]} onSelect={protocol => editPort(i, { protocol })} /></div>
          <label className="min-w-0">宿主地址<input className={inputClass} value={port.hostIp ?? ''} placeholder="所有地址" onChange={e => editPort(i, { hostIp: e.target.value })} /></label>
          <Button type="button" variant="ghost" onClick={() => setPorts((ports ?? [...container.ports]).filter((_, index) => index !== i))}>移除端口</Button>
        </div>)}
        <Button type="button" variant="outline" onClick={() => setPorts([...(ports ?? container.ports), newPort()])}>添加端口</Button>
      </fieldset>
      <fieldset className={groupClass} disabled={busy}><legend>环境变量</legend>
        <p className="text-xs text-fg-muted">添加需要改变的键。输入值仅用于本次重建，预览不会显示值。</p>
        {env.map((row, i) => <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <label className="min-w-0">变量名<input required list="current-env" className={inputClass} value={row.key} onChange={e => editEnv(i, { ...row, key: e.target.value })} /></label>
          <div>操作<SelectDropdown ariaLabel="变量操作" fullWidth disabled={busy} value={row.remove ? 'remove' : 'set'}
            items={[{ value: 'set', label: '写入' }, { value: 'remove', label: '删除' }]}
            onSelect={action => editEnv(i, action === 'remove' ? { key: row.key, remove: true } : { key: row.key, value: '' })} /></div>
          {!row.remove && <label className="col-span-2">新值<input autoComplete="off" type="password" className={inputClass} value={row.value ?? ''} onChange={e => editEnv(i, { ...row, value: e.target.value })} /></label>}
          <Button type="button" variant="ghost" onClick={() => setEnv(env.filter((_, index) => index !== i))}>移除此改动</Button>
        </div>)}
        <datalist id="current-env">{container.env.map(row => <option key={row.key} value={row.key} />)}</datalist>
        <Button type="button" variant="outline" onClick={() => setEnv([...env, { key: '', value: '' }])}>新增环境变量改动</Button>
      </fieldset>
      <fieldset className={groupClass} disabled={busy}><legend>挂载</legend>
        {(mounts ?? config.mounts).map((mount, i) => <div key={i} className="space-y-2">
          <div>类型<SelectDropdown ariaLabel="挂载类型" fullWidth disabled={busy} value={mount.kind}
            items={[{ value: 'bind', label: '绑定路径' }, { value: 'volume', label: '已有卷' }]}
            fallbackLabel={mount.kind === 'tmpfs' ? '临时文件系统' : undefined} onSelect={kind => editMount(i, { kind })} /></div>
          <label className="block">来源<input className={inputClass} value={mount.source} onChange={e => editMount(i, { source: e.target.value })} /></label>
          <label className="block">容器路径<input required className={inputClass} value={mount.target} onChange={e => editMount(i, { target: e.target.value })} /></label>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1">只读 <ToggleSwitch label="只读挂载" checked={mount.readOnly} disabled={busy} onCheckedChange={readOnly => editMount(i, { readOnly })} /></span>
            <Button type="button" variant="ghost" onClick={() => setMounts((mounts ?? [...config.mounts]).filter((_, index) => index !== i))}>移除挂载</Button>
          </div>
        </div>)}
        <Button type="button" variant="outline" onClick={() => setMounts([...(mounts ?? config.mounts), newMount()])}>添加挂载</Button>
      </fieldset>
      <div className="flex gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button type="submit" isLoading={busy}>预览变更</Button>
      </div>
    </form>}
  </div>
}
