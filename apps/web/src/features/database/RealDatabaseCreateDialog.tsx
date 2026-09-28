import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useState } from 'react'
import type { ContainerImage, DatabaseEngine } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { SelectDropdown } from '../../components/SelectDropdown'
import { useDatabaseStore } from '../../stores/databaseStore'
import { generateDemoPassword } from './databaseCreateForm'

type Engine = Exclude<DatabaseEngine, 'SQLite'>
type Candidate = { id: string; name: string; accessScope: string; managed: boolean }
const FIELD = 'w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg'
const LABEL = 'mb-1 block text-xs font-medium text-fg-muted'
const DROPDOWN_TRIGGER = 'inline-flex w-full items-center justify-between gap-1.5 rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg transition-colors hover:border-fg-subtle'
const CHARSET_ITEMS = [
  { value: 'utf8mb4', label: 'utf8mb4' },
  { value: 'utf8', label: 'utf8' },
  { value: 'latin1', label: 'latin1' },
] as const
const ACCESS_SCOPE_ITEMS = [
  { value: 'localhost', label: '仅宿主回环' },
  { value: 'container-network', label: '容器网络内' },
  { value: 'any-host', label: '任意主机' },
] as const

export function RealDatabaseCreateDialog({ engine }: { engine: Engine }) {
  const gateway = useGateway()
  const close = useDatabaseStore((s) => s.closeCreate)
  const create = useDatabaseStore((s) => s.createDatabase)
  const creating = useDatabaseStore((s) => s.creating)
  const [versionTag, setVersionTag] = useState('')
  const [name, setName] = useState(engine === 'Redis' ? '0' : '')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [adminUsername, setAdminUsername] = useState(engine === 'Redis' ? 'default' : 'root')
  const [adminPassword, setAdminPassword] = useState('')
  const [scope, setScope] = useState<'localhost' | 'container-network' | 'any-host'>('localhost')
  const [hostPort, setHostPort] = useState('')
  const [confirmPublic, setConfirmPublic] = useState(false)
  const [charset, setCharset] = useState('utf8mb4')
  const [targetKind, setTargetKind] = useState<'new' | 'adopt'>('new')
  const [containerName, setContainerName] = useState(`elysian-${engine.toLowerCase()}`)
  const [containerId, setContainerId] = useState('')
  const [images, setImages] = useState<readonly ContainerImage[]>([])
  const [candidates, setCandidates] = useState<readonly Candidate[]>([])
  const [loading, setLoading] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!/^\d+(?:\.\d+){0,2}(?:[-.][A-Za-z0-9]+)*$/.test(versionTag)) {
      setImages([]); setCandidates([]); return
    }
    let active = true
    setLoading(true)
    void gateway.databases.discover?.(engine, versionTag).then((result) => {
      if (!active || !result) return
      setImages(result.images)
      setCandidates(result.containers)
      setError('')
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : '查询镜像失败')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [engine, versionTag, gateway])

  const selectedContainer = candidates.find((candidate) => candidate.id === containerId)
  const image = images[0]
  const canSubmit = !creating && !pulling && !loading && /^\d+(?:\.\d+){0,2}(?:[-.][A-Za-z0-9]+)*$/.test(versionTag) &&
    (engine === 'Redis' || /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) &&
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(username) && username !== (engine === 'Redis' ? 'default' : 'root') && password.length >= (targetKind === 'new' ? 12 : 1) &&
    (targetKind === 'new' ? Boolean(image) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(containerName) &&
      (scope !== 'any-host' || (Number(hostPort) >= 1 && Number(hostPort) <= 65535 && confirmPublic))
      : Boolean(selectedContainer) && (selectedContainer?.managed || (Boolean(adminUsername) && adminPassword.length >= 1)))

  const pull = async () => {
    setPulling(true)
    setError('')
    try {
      setProgress('准备拉取镜像…')
      await gateway.containers.pullImage({ name: engine.toLowerCase(), tag: versionTag }, (next) => {
        const ratio = next.totalBytes ? ` ${Math.round((next.currentBytes ?? 0) / next.totalBytes * 100)}%` : ''
        setProgress(`拉取镜像：${next.phase}${ratio}`)
      })
      const result = await gateway.databases.discover?.(engine, versionTag)
      if (result) { setImages(result.images); setCandidates(result.containers) }
      setProgress('镜像已拉取')
    } catch (failure) { setError(failure instanceof Error ? failure.message : '镜像拉取失败') }
    finally { setPulling(false) }
  }

  const submit = () => {
    if (!canSubmit) return
    void create(gateway, {
      kind: 'container', engine, versionTag, name: engine === 'Redis' ? '0' : name,
      charset: engine === 'Redis' ? undefined : charset, username, password,
      accessScope: targetKind === 'adopt' ? selectedContainer!.accessScope as typeof scope : scope,
      hostPort: targetKind === 'new' && scope === 'any-host' ? Number(hostPort) : undefined,
      confirmPublic: targetKind === 'new' && scope === 'any-host' ? confirmPublic : undefined,
      containerId: targetKind === 'adopt' ? containerId : '',
      target: targetKind === 'new'
        ? { kind: 'new', imageId: image!.id, containerName }
        : selectedContainer?.managed
          ? { kind: 'managed', containerId }
          : { kind: 'adopt', containerId, admin: { username: adminUsername, password: adminPassword } },
    })
  }

  return <Dialog.Root open onOpenChange={(open) => { if (!open) close() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <Dialog.Content aria-describedby={undefined} onPointerDownOutside={(event) => event.preventDefault()} className="fixed left-1/2 top-1/2 z-[51] flex max-h-[90vh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface p-5 shadow-xl">
        <Dialog.Title className="mb-4 text-base font-semibold">添加 {engine} 数据库</Dialog.Title>
        <div className="space-y-3 overflow-y-auto pr-1">
          <div><label htmlFor="real-db-version" className={LABEL}>版本标签（必填，不支持 latest）</label><input id="real-db-version" className={FIELD} value={versionTag} onChange={(event) => setVersionTag(event.target.value.trim())} placeholder={engine === 'MariaDB' ? '例如 11.4' : engine === 'MySQL' ? '例如 8.4' : '例如 7.4'} /></div>
          {engine !== 'Redis' ? <div><label htmlFor="real-db-name" className={LABEL}>逻辑库名</label><input id="real-db-name" className={FIELD} value={name} onChange={(event) => setName(event.target.value)} /></div> : <p className="text-xs text-fg-muted">Redis 卡片对应容器内的 DB 0。</p>}
          {engine !== 'Redis' ? <div><label htmlFor="real-db-charset" className={LABEL}>字符集</label><SelectDropdown id="real-db-charset" ariaLabel="字符集" fullWidth triggerClassName={DROPDOWN_TRIGGER} items={CHARSET_ITEMS} value={charset} onSelect={setCharset} /></div> : null}
          <div className="grid grid-cols-2 gap-3">
            <div><label htmlFor="real-db-user" className={LABEL}>普通账号</label><input id="real-db-user" className={FIELD} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" /></div>
            <div><label htmlFor="real-db-password" className={LABEL}>{targetKind === 'new' ? '普通账号密码（至少 12 位）' : '现有普通账号密码'}</label><div className="flex gap-1"><input id="real-db-password" type="password" className={FIELD} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /><button type="button" onClick={() => setPassword(generateDemoPassword(24))} className="rounded-lg border border-line px-2 text-xs">生成</button></div></div>
          </div>
          <div className="flex gap-2 border-b border-line pb-2 text-xs"><button type="button" aria-pressed={targetKind === 'new'} onClick={() => setTargetKind('new')} className="rounded border border-line px-3 py-1">创建新容器</button><button type="button" aria-pressed={targetKind === 'adopt'} onClick={() => setTargetKind('adopt')} className="rounded border border-line px-3 py-1">接管已有容器</button></div>
          {targetKind === 'new' ? <>
            {versionTag && !loading && !image ? <div className="rounded-lg border border-warning/50 p-3 text-xs"><p>当前没有 {engine}:{versionTag} 镜像。</p><button type="button" disabled={pulling} onClick={() => void pull()} className="mt-2 rounded border border-line px-3 py-1">{pulling ? '正在拉取…' : '拉取镜像'}</button><p role="status">{progress}</p></div> : null}
            <div><label htmlFor="real-db-container" className={LABEL}>新容器名称</label><input id="real-db-container" className={FIELD} value={containerName} onChange={(event) => setContainerName(event.target.value)} /></div>
            <div><label htmlFor="real-db-scope" className={LABEL}>访问范围</label><SelectDropdown id="real-db-scope" ariaLabel="访问范围" fullWidth triggerClassName={DROPDOWN_TRIGGER} items={ACCESS_SCOPE_ITEMS} value={scope} onSelect={setScope} /></div>
            {scope === 'any-host' ? <><div><label htmlFor="real-db-port" className={LABEL}>宿主端口</label><input id="real-db-port" type="number" min="1" max="65535" className={FIELD} value={hostPort} onChange={(event) => setHostPort(event.target.value)} /></div><label className="flex gap-2 text-xs text-warning"><input type="checkbox" checked={confirmPublic} onChange={(event) => setConfirmPublic(event.target.checked)} />确认数据库端口将监听所有宿主网卡</label></> : null}
          </> : <>
            <div><label htmlFor="real-db-existing" className={LABEL}>运行中的匹配容器</label><SelectDropdown id="real-db-existing" ariaLabel="运行中的匹配容器" fullWidth triggerClassName={DROPDOWN_TRIGGER} items={candidates.map((candidate) => ({ value: candidate.id, label: `${candidate.name} · ${candidate.accessScope}${candidate.managed ? ' · 面板管理' : ''}` }))} value={containerId || undefined} onSelect={setContainerId} fallbackLabel="选择容器" emptyLabel="没有可接管的运行中容器" /></div>
            <p className="text-xs text-fg-muted">接管不会修改容器端口或网络范围。面板创建的容器复用已保存的管理员账号；外部容器需要提供现有管理员账号。</p>
            {!selectedContainer?.managed ? <><div><label htmlFor="real-db-admin" className={LABEL}>已有管理员账号</label><input id="real-db-admin" className={FIELD} value={adminUsername} onChange={(event) => setAdminUsername(event.target.value)} /></div>
            <div><label htmlFor="real-db-admin-password" className={LABEL}>管理员密码</label><input id="real-db-admin-password" type="password" className={FIELD} value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} /></div></> : null}
          </>}
          {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
        </div>
        <div className="mt-4 flex justify-end gap-2 border-t border-line pt-3"><button type="button" onClick={close} className="rounded-lg border border-line px-3 py-1.5 text-xs">取消</button><button type="button" disabled={!canSubmit} onClick={submit} className="rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs disabled:opacity-50">{creating ? '创建中…' : targetKind === 'adopt' ? '验证并接管' : '创建并启动'}</button></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
