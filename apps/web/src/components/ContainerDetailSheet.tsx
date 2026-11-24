import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CONTAINER_STATUS_LABELS, RESTART_POLICY_LABELS, type Container, type ContainerRecreateConfig } from '@elysian/contracts'
import { Link } from 'react-router'
import { useGateway } from '../adapters/GatewayProvider'
import { readContainerInventory, useContainersStore } from '../stores/containersStore'
import { useClipboardCopy } from './CopyButton'
import { IconButton } from './IconButton'
import { Button } from './Button'
import { Copy, Check, X } from './icons'
import { Badge } from './easyui/Badge'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './easyui/Sheet'
import { SmoothAccordion } from './easyui/SmoothAccordion'
import { ScrollArea } from './ScrollArea'
import { formatUptime } from './format'
import { ContainerStartupCommand } from './ContainerStartupCommand'
import { ContainerRecreateEditor, ContainerRecreateStatus } from './ContainerRecreateEditor'

const STATUS_TONE = { running: 'success', stopped: 'neutral', restarting: 'warning', paused: 'warning' } as const

function Rows({ rows }: { rows: readonly { key: string; value: ReactNode }[] }) {
  return <dl className="divide-y divide-line">
    {rows.map(({ key, value }, i) => <div key={`${key}-${i}`} className="@sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] grid gap-x-3 gap-y-0.5 py-1.5">
      <dt className="min-w-0 text-fg-muted [overflow-wrap:anywhere]">{key}</dt>
      <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">{value}</dd>
    </div>)}
  </dl>
}

function ContainerDetail({ container, close }: { container: Container; close(): void }) {
  const gateway = useGateway()
  const image = useContainersStore(s => s.images.find(candidate => candidate.id === container.imageId))
  const [config, setConfig] = useState<ContainerRecreateConfig>()
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [editing, setEditing] = useState(false)
  const { copied, copy, error: copyError } = useClipboardCopy()
  useEffect(() => {
    if (!gateway.containers.recreateConfig) return
    const abort = new AbortController()
    void gateway.containers.recreateConfig(container.id, abort.signal).then(value => {
      if (!abort.signal.aborted) { setConfig(value); setError('') }
    }).catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : '无法读取容器配置') })
    return () => abort.abort()
  }, [container.id, gateway, reload])
  const current = config?.container ?? container
  const mounts = config?.mounts ?? current.volumes.map(m => ({ source: m.hostPath, target: m.containerPath, kind: m.kind, readOnly: false }))
  const task = config?.latest
  const refresh = () => {
    setReload(value => value + 1)
    void readContainerInventory(gateway, { fresh: true }).catch(() => {})
  }
  const summary = [
    { id: 'overview', title: '基本信息', content: <Rows rows={[
      { key: '创建时间', value: current.createdAt.slice(0, 10) },
      { key: '运行时长', value: formatUptime(current.startedAt, new Date()) },
      { key: '重启策略', value: RESTART_POLICY_LABELS[current.restartPolicy] },
    ]} /> },
    { id: 'image', title: '镜像', content: <Rows rows={[
      { key: '名称', value: current.imageRef ?? (image ? `${image.name}:${image.tag}` : current.imageId) },
      { key: '摘要', value: <code>{image?.digest ?? current.imageId}</code> },
    ]} /> },
    { id: 'ports', title: '端口映射', content: current.ports.length ? <Rows rows={current.ports.map(port => ({
      key: `${port.protocol.toUpperCase()} · ${port.containerPort}`,
      value: <code>{port.hostIp || '所有地址'} · {port.hostPort}</code>,
    }))} /> : '无' },
    { id: 'env', title: '环境变量', content: current.env.length ? <Rows rows={current.env.map(pair => ({
      key: pair.key, value: <code className="whitespace-pre-wrap">{pair.value ?? '已隐藏'}</code>,
    }))} /> : '无' },
    { id: 'mounts', title: '挂载', content: mounts.length ? <Rows rows={mounts.map(mount => ({
      key: mount.target, value: <><code>{mount.source}</code><span className="ml-2 text-fg-muted">{mount.kind}{mount.readOnly ? ' · 只读' : ''}</span></>,
    }))} /> : '无' },
    { id: 'command', title: '启动命令', content: <ContainerStartupCommand argv={config?.argv} fallback={current.command} /> },
  ]
  const canEdit = config && !config.blockedReason && !config.composeManaged && task?.state !== 'running' && task?.state !== 'unknown' && gateway.containers.submitRecreate
  return <>
    <SheetHeader>
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <SheetTitle className="min-w-0 text-base font-semibold [overflow-wrap:anywhere]">{current.name}</SheetTitle>
            <Badge tone={STATUS_TONE[current.status]}>{CONTAINER_STATUS_LABELS[current.status]}</Badge>
          </div>
          <div className="mt-1 flex min-w-0 items-start gap-1">
            <code className="min-w-0 font-mono text-xs text-fg-muted [overflow-wrap:anywhere]">{current.id}</code>
            <IconButton label={copied ? '已复制容器 ID' : '复制容器 ID'} tooltip={false} variant="ghost" onPress={() => void copy(current.id, '容器 ID')}>
              {copied ? <Check aria-hidden size={14} /> : <Copy aria-hidden size={14} />}
            </IconButton>
          </div>
          {copyError && <p role="alert" className="text-xs text-danger">{copyError}</p>}
        </div>
        <IconButton label="关闭详情" variant="ghost" onPress={close}><X aria-hidden size={16} /></IconButton>
      </div>
    </SheetHeader>
    <ScrollArea className="min-h-0 flex-1" label="容器详情正文">
      <div className="@container min-w-0 space-y-3 px-4 py-3 sm:px-5">
        {error && <div role="status" className="text-xs text-fg-muted">{error} <Button variant="link" onClick={() => setReload(value => value + 1)}>重试</Button></div>}
        {config?.composeManaged && <p className="text-sm [overflow-wrap:anywhere]">
          Compose 项目 {config.composeProject || '未知'} · 服务 {config.composeService || '未知'}。
          请修改项目配置后重新部署。 {config.composeWorkspace && <Link className="underline" to={`/docker#workspace-${config.composeWorkspace}`} onClick={() => { close(); useContainersStore.getState().setTab('apps') }}>容器工作区 · {config.composeWorkspace}</Link>}
        </p>}
        {!config?.composeManaged && config?.blockedReason && <p className="text-sm text-fg-muted">{config.blockedReason}</p>}
        {editing && config ? <ContainerRecreateEditor config={config} gateway={gateway}
          onClose={() => setEditing(false)} onTask={latest => setConfig(previous => previous && { ...previous, latest })} /> : <>
          {task && <ContainerRecreateStatus task={task} gateway={gateway} onChange={latest => setConfig(previous => previous && { ...previous, latest })} refresh={refresh} />}
          <SmoothAccordion items={summary} allowMultiple defaultOpen={summary.map(item => item.id)} />
        </>}
      </div>
    </ScrollArea>
    {!editing && canEdit && <footer className="shrink-0 border-t border-line px-4 py-3 sm:px-5">
      <Button type="button" onClick={() => setEditing(true)}>编辑配置</Button>
    </footer>}
  </>
}

export function ContainerDetailSheet() {
  const selected = useContainersStore(s => s.containers.find(c => c.id === s.detailContainerId))
  const close = useContainersStore(s => s.closeDetail)
  const last = useRef(selected)
  if (selected) last.current = selected
  const container = selected ?? last.current
  if (!container) return null
  return <Sheet open={!!selected} onOpenChange={open => { if (!open) close() }}>
    <SheetContent onDismiss={close}><ContainerDetail key={container.id} container={container} close={close} /></SheetContent>
  </Sheet>
}
