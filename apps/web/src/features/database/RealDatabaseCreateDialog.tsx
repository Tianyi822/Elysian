import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useState } from 'react'
import type { ContainerImage, DatabaseEngine, ImagePullProgress } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { FORM_CONTROL_HEIGHT_CLASS } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { Loader2, X } from '../../components/icons'
import { useDatabaseStore } from '../../stores/databaseStore'
import { DEFAULT_IMAGE_REGISTRY, registryHost, validateRegistryUrl } from '../container/imageReference'
import { PasswordVisibilityButton } from '../security/passwordFieldParts'
import { generateDemoPassword } from './databaseCreateForm'

type Engine = Exclude<DatabaseEngine, 'SQLite'>
type Candidate = { id: string; name: string; accessScope: string; managed: boolean; versionTag: string }
type Scope = 'localhost' | 'container-network' | 'any-host'

const VERSION_PATTERN = /^\d+(?:\.\d+){0,2}(?:[-.][A-Za-z0-9]+)*$/
const FIELD = `${FORM_CONTROL_HEIGHT_CLASS} w-full min-w-0 rounded-lg border border-line bg-surface-raised px-3 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle disabled:opacity-60`
const LABEL = 'mb-2 block text-xs font-medium leading-5 text-fg-muted'
const BUTTON = `inline-flex ${FORM_CONTROL_HEIGHT_CLASS} items-center justify-center rounded-lg border border-line px-3 text-xs font-medium text-fg transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50`
const CHARSET_ITEMS = [{ value: 'utf8mb4', label: 'utf8mb4' }, { value: 'utf8', label: 'utf8' }, { value: 'latin1', label: 'latin1' }] as const
const ACCESS_SCOPE_ITEMS = [
  { value: 'localhost', label: '仅宿主回环' },
  { value: 'container-network', label: '容器网络内' },
  { value: 'any-host', label: '任意主机' },
] as const

function imageHasTag(image: ContainerImage, repo: string, tag: string): boolean {
  const names = [repo, 'library/' + repo, 'docker.io/library/' + repo]
  return (names.includes(image.name) && image.tag === tag) ||
    (image.otherTags ?? []).some((ref) => names.some((name) => ref === name + ':' + tag))
}

function pullBytes(bytes: number): string {
  if (bytes < 1024) return Math.round(bytes) + ' B'
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB'
}

function pullPhase(progress?: ImagePullProgress): string {
  switch (progress?.phase) {
    case 'downloading': return '下载镜像层'
    case 'extracting': return '解压镜像层'
    case 'finalizing': return '正在校验并写入镜像'
    default: return '正在准备镜像层'
  }
}

export function RealDatabaseCreateDialog({ engine }: { engine: Engine }) {
  const gateway = useGateway()
  const close = useDatabaseStore((state) => state.closeCreate)
  const create = useDatabaseStore((state) => state.createDatabase)
  const refresh = useDatabaseStore((state) => state.refresh)
  const creating = useDatabaseStore((state) => state.creating)
  const createError = useDatabaseStore((state) => state.createError)
  const [targetKind, setTargetKind] = useState<'existing' | 'new'>('existing')
  const [candidates, setCandidates] = useState<readonly Candidate[]>([])
  const [images, setImages] = useState<readonly ContainerImage[]>([])
  const [containerId, setContainerId] = useState('')
  const [loading, setLoading] = useState(true)
  const [discoverError, setDiscoverError] = useState('')
  const [registryAddress, setRegistryAddress] = useState('')
  const [versionTag, setVersionTag] = useState('')
  const [tags, setTags] = useState<readonly string[]>([])
  const [tagStatus, setTagStatus] = useState<'idle' | 'loading' | 'unavailable'>('idle')
  const [pulling, setPulling] = useState(false)
  const [progress, setProgress] = useState<ImagePullProgress>()
  const [pullError, setPullError] = useState('')
  const [pullComplete, setPullComplete] = useState(false)
  const [name, setName] = useState(engine === 'Redis' ? '0' : '')
  const [charset, setCharset] = useState('utf8mb4')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [adminUsername, setAdminUsername] = useState(engine === 'Redis' ? 'default' : 'root')
  const [adminPassword, setAdminPassword] = useState('')
  const [adminPasswordVisible, setAdminPasswordVisible] = useState(false)
  const [containerName, setContainerName] = useState('elysian-' + engine.toLowerCase())
  const [scope, setScope] = useState<Scope>('localhost')
  const [hostPort, setHostPort] = useState('')
  const [confirmPublic, setConfirmPublic] = useState(false)

  const repo = engine.toLowerCase()
  const selectedContainer = candidates.find((candidate) => candidate.id === containerId)
  const validVersion = VERSION_PATTERN.test(versionTag) && !/latest/i.test(versionTag)
  const image = validVersion ? images.find((candidate) => imageHasTag(candidate, repo, versionTag)) : undefined
  const registryError = registryAddress.trim() ? validateRegistryUrl(registryAddress) : undefined
  const registry = registryAddress.trim() || DEFAULT_IMAGE_REGISTRY
  const busy = pulling || creating

  const discover = async (): Promise<boolean> => {
    setLoading(true)
    setDiscoverError('')
    try {
      const result = await gateway.databases.discover?.(engine)
      if (!result) throw new Error('容器发现功能不可用')
      setCandidates(result.containers)
      setImages(result.images)
      setContainerId((current) => result.containers.some((candidate) => candidate.id === current) ? current : '')
      return true
    } catch (error) {
      setDiscoverError(error instanceof Error ? error.message : '读取容器失败')
      return false
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void discover() }, [engine, gateway])

  useEffect(() => {
    const controller = new AbortController()
    setTags([])
    if (targetKind !== 'new' || registryError) { setTagStatus('idle'); return () => controller.abort() }
    setTagStatus('loading')
    const timer = setTimeout(() => {
      void gateway.containers.imageTags(repo, registryAddress.trim() || undefined, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return
          setTags(result.tags.filter((tag) => VERSION_PATTERN.test(tag) && !/latest/i.test(tag)))
          setTagStatus(result.searchable ? 'idle' : 'unavailable')
        })
        .catch(() => { if (!controller.signal.aborted) setTagStatus('unavailable') })
    }, 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [gateway, repo, registryAddress, registryError, targetKind])

  const pull = async () => {
    if (pulling || loading || !validVersion || registryError || image) return
    setPulling(true)
    setProgress(undefined)
    setPullError('')
    setPullComplete(false)
    try {
      await gateway.containers.pullImage({ name: repo, tag: versionTag, ...(registryAddress.trim() ? { registry: registryAddress.trim() } : {}) }, setProgress)
      if (!await discover()) return
      await refresh(gateway)
      setPullComplete(true)
    } catch (error) {
      setPullError(error instanceof Error ? error.message : '镜像拉取失败')
    } finally {
      setPulling(false)
    }
  }

  const targetVersion = targetKind === 'existing' ? selectedContainer?.versionTag : versionTag
  const validName = engine === 'Redis' || /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)
  const validUser = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(username) && username !== (engine === 'Redis' ? 'default' : 'root')
  const validPassword = password.length >= (targetKind === 'new' ? 12 : 1) && password.length <= 256
  const validAdmin = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(adminUsername) && adminPassword.length >= 1 && adminPassword.length <= 256
  const validContainerName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(containerName)
  const validPort = Number.isInteger(Number(hostPort)) && Number(hostPort) >= 1 && Number(hostPort) <= 65535
  const readyTarget = targetKind === 'existing'
    ? Boolean(selectedContainer) && (selectedContainer?.managed || validAdmin)
    : validVersion && Boolean(image) && validContainerName && (scope !== 'any-host' || (validPort && confirmPublic))
  const canSubmit = !busy && !loading && !discoverError && validName && validUser && validPassword && readyTarget
  const hint = loading ? '正在查找可用容器…'
    : discoverError ? '请重试读取容器和镜像'
      : targetKind === 'existing' && !selectedContainer ? '先选择已有容器'
        : targetKind === 'new' && !validVersion ? '请填写明确版本标签'
          : targetKind === 'new' && !image ? '请先拉取镜像'
            : !validName || !validUser || !validPassword ? '请完成数据库和账号信息'
              : targetKind === 'existing' && !selectedContainer?.managed && !validAdmin ? '请填写有效的管理员凭证'
                : targetKind === 'new' && !validContainerName ? '请填写有效的容器名称'
                  : targetKind === 'new' && scope === 'any-host' && (!validPort || !confirmPublic) ? '请填写端口并确认公开访问' : ''

  const submit = () => {
    if (!canSubmit || !targetVersion) return
    void create(gateway, {
      kind: 'container', engine, versionTag: targetVersion, name: engine === 'Redis' ? '0' : name,
      charset: engine === 'Redis' ? undefined : charset, username, password,
      accessScope: targetKind === 'existing' ? selectedContainer!.accessScope as Scope : scope,
      hostPort: targetKind === 'new' && scope === 'any-host' ? Number(hostPort) : undefined,
      confirmPublic: targetKind === 'new' && scope === 'any-host' ? confirmPublic : undefined,
      containerId: targetKind === 'existing' ? containerId : '',
      target: targetKind === 'new'
        ? { kind: 'new', imageId: image!.id, containerName }
        : selectedContainer!.managed
          ? { kind: 'managed', containerId }
          : { kind: 'adopt', containerId, admin: { username: adminUsername, password: adminPassword } },
    })
  }

  const tagItems = [
    ...(validVersion && !tags.includes(versionTag) ? [{ value: versionTag, label: versionTag + '（当前输入）' }] : []),
    ...tags.map((tag) => ({ value: tag, label: tag })),
  ]

  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) close() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <Dialog.Content aria-describedby={undefined} onPointerDownOutside={(event) => event.preventDefault()}
        className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(44rem,calc(100vh-2rem))] w-[min(42rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
          <Dialog.Title className="truncate text-base font-semibold text-fg">添加 {engine} 数据库</Dialog.Title>
          <button type="button" disabled={busy} onClick={close} aria-label="关闭弹窗" className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-raised disabled:opacity-50"><X aria-hidden size={16} /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <section aria-labelledby="db-target-title">
            <h3 id="db-target-title" className="mb-3 text-sm font-semibold text-fg">承载容器</h3>
            <div role="group" aria-label="容器来源" className="grid grid-cols-2 gap-2">
              <button type="button" disabled={busy} aria-pressed={targetKind === 'existing'} onClick={() => setTargetKind('existing')}
                className={BUTTON + (targetKind === 'existing' ? ' border-accent/50 bg-accent/10 text-accent' : '')}>使用已有容器</button>
              <button type="button" disabled={busy} aria-pressed={targetKind === 'new'} onClick={() => setTargetKind('new')}
                className={BUTTON + (targetKind === 'new' ? ' border-accent/50 bg-accent/10 text-accent' : '')}>创建新容器</button>
            </div>

            {targetKind === 'existing' ? <div className="mt-4">
              <label htmlFor="real-db-existing" className={LABEL}>运行中的 {engine} 容器</label>
              <SelectDropdown id="real-db-existing" ariaLabel="运行中的容器" fullWidth disabled={busy || loading || Boolean(discoverError)}
                items={candidates.map((candidate) => ({ value: candidate.id, label: candidate.name + ' · ' + repo + ':' + candidate.versionTag + (candidate.managed ? ' · 面板管理' : ' · 外部容器') }))}
                value={containerId || undefined} onSelect={setContainerId} fallbackLabel="选择已有容器" emptyLabel="没有可用的运行中容器" />
              {selectedContainer ? <p className="mt-2 text-xs text-fg-muted">版本 {selectedContainer.versionTag} · {ACCESS_SCOPE_ITEMS.find((item) => item.value === selectedContainer.accessScope)?.label ?? selectedContainer.accessScope} · {selectedContainer.managed ? '创建新逻辑库' : '验证并接管已有库'}</p> : null}
              {!loading && !discoverError && candidates.length === 0 ? <div className="mt-3 rounded-lg border border-line bg-surface-raised p-3 text-xs text-fg-muted">
                <p>没有可用的 {engine} 容器。</p>
                <button type="button" onClick={() => setTargetKind('new')} className={BUTTON + ' mt-2 bg-surface'}>拉取镜像并新建容器</button>
              </div> : null}
              {selectedContainer && !selectedContainer.managed ? <p className="mt-2 text-xs text-fg-muted">外部容器需已有数据库和普通账号；接管不修改端口或网络范围。</p> : null}
            </div> : <div className="mt-4 space-y-4">
              <div>
                <label htmlFor="real-db-registry" className={LABEL}>自定义镜像源地址</label>
                <input id="real-db-registry" className={FIELD} disabled={busy} value={registryAddress} onChange={(event) => setRegistryAddress(event.target.value)} placeholder="留空使用官方地址 registry-1.docker.io" autoComplete="off" spellCheck={false} />
                {registryError ? <p role="alert" className="mt-1 text-xs text-danger">{registryError}</p> : null}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div><span className={LABEL}>镜像名称</span><p className={FIELD + ' flex items-center font-mono'} aria-label="镜像名称">{repo}</p></div>
                <div>
                  <label htmlFor="real-db-version" className={LABEL}>版本标签（不支持 latest）</label>
                  <div className="flex min-w-0 gap-2">
                    <input id="real-db-version" className={FIELD + ' min-w-0 flex-1 font-mono'} disabled={busy} value={versionTag} onChange={(event) => { setVersionTag(event.target.value.trim()); setPullComplete(false); setPullError('') }} placeholder={engine === 'MariaDB' ? '例如 11.4' : engine === 'MySQL' ? '例如 8.4' : '例如 7.4'} autoComplete="off" spellCheck={false} />
                    <SelectDropdown ariaLabel="版本标签建议" disabled={busy || tags.length === 0} items={tagItems} value={undefined} onSelect={(tag) => { setVersionTag(tag); setPullComplete(false); setPullError('') }} fallbackLabel="选择版本" triggerClassName={`inline-flex ${FORM_CONTROL_HEIGHT_CLASS} shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-line bg-surface-raised px-2 text-xs text-fg disabled:opacity-50`} />
                  </div>
                  {versionTag && !validVersion ? <p role="alert" className="mt-1 text-xs text-danger">请输入明确的数字版本标签</p> : null}
                  {tagStatus === 'loading' ? <p role="status" className="mt-1 text-xs text-fg-subtle">正在查询版本…</p> : null}
                  {tagStatus === 'unavailable' ? <p className="mt-1 text-xs text-fg-subtle">版本列表不可用，可手动输入。</p> : null}
                </div>
              </div>
              {validVersion && !registryError ? <div className="rounded-lg border border-line bg-surface-raised px-3 py-2 text-xs">
                <span className="text-fg-muted">{image ? '本地镜像 ' : '将拉取 '}</span><span className="break-all font-mono text-fg">{image ? repo + ':' + versionTag : registryHost(registry) + '/' + repo + ':' + versionTag}</span>
              </div> : null}
              {validVersion && !loading && !discoverError ? image ? <p role="status" className="text-xs text-success">本地镜像已就绪：{repo}:{versionTag}</p> : <div className="rounded-lg border border-line bg-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-fg-muted">本地尚无 {repo}:{versionTag} 镜像</p>
                  <button type="button" disabled={busy || Boolean(registryError)} onClick={() => void pull()} className={BUTTON}>{pulling ? '拉取中…' : '拉取镜像'}</button>
                </div>
                {pulling ? <div className="mt-3" role="status" aria-live="polite">
                  <div className="flex flex-wrap justify-between gap-1 text-xs text-fg-muted">
                    <span>{pullPhase(progress)}{progress?.layerId ? ' · ' + progress.layerId.slice(0, 12) : ''}</span>
                    {progress?.totalBytes ? <span className="tabular-nums">{pullBytes(progress.currentBytes ?? 0)} / {pullBytes(progress.totalBytes)} · {Math.floor((progress.currentBytes ?? 0) / progress.totalBytes * 100)}%</span> : null}
                  </div>
                  <div role="progressbar" aria-label="当前窗口镜像拉取进度" aria-valuemin={0} aria-valuemax={100}
                    aria-valuenow={progress?.totalBytes ? Math.floor((progress.currentBytes ?? 0) / progress.totalBytes * 100) : undefined}
                    className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-surface-raised">
                    {progress?.totalBytes ? <span className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-150 motion-reduce:transition-none" style={{ width: Math.min(100, (progress.currentBytes ?? 0) / progress.totalBytes * 100) + '%' }} />
                      : <span className="pull-progress absolute inset-y-0 left-0 w-1/3 rounded-full bg-accent/60 motion-reduce:animate-none" />}
                  </div>
                </div> : null}
                {pullError ? <p role="alert" className="mt-2 text-xs text-danger">拉取失败：{pullError}</p> : null}
              </div> : null}
              {pullComplete ? <p role="status" className="text-xs text-success">镜像已拉取，可以继续创建。</p> : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <div><label htmlFor="real-db-container" className={LABEL}>新容器名称</label><input id="real-db-container" className={FIELD} disabled={busy} value={containerName} onChange={(event) => setContainerName(event.target.value)} /></div>
                <div><label htmlFor="real-db-scope" className={LABEL}>访问范围</label><SelectDropdown id="real-db-scope" ariaLabel="访问范围" fullWidth disabled={busy} items={ACCESS_SCOPE_ITEMS} value={scope} onSelect={setScope} /></div>
              </div>
              {scope === 'any-host' ? <div className="space-y-3">
                <div><label htmlFor="real-db-port" className={LABEL}>宿主端口</label><input id="real-db-port" type="number" min="1" max="65535" className={FIELD} disabled={busy} value={hostPort} onChange={(event) => setHostPort(event.target.value)} /></div>
                <label className="flex items-start gap-2 text-xs leading-5 text-warning"><input type="checkbox" className="mt-0.5" disabled={busy} checked={confirmPublic} onChange={(event) => setConfirmPublic(event.target.checked)} />确认数据库端口将监听所有宿主网卡</label>
                <p className="text-xs text-fg-subtle">创建成功后将自动在防火墙开放该端口。</p>
              </div> : null}
            </div>}
          </section>

          <section aria-labelledby="db-details-title" className="border-t border-line pt-5">
            <h3 id="db-details-title" className="mb-3 text-sm font-semibold text-fg">数据库信息</h3>
            {engine === 'Redis' ? <p className={`${FORM_CONTROL_HEIGHT_CLASS} flex items-center rounded-lg border border-line bg-surface-raised px-3 text-sm text-fg`}>Redis DB 0</p> : <div className="grid gap-4 sm:grid-cols-2">
              <div><label htmlFor="real-db-name" className={LABEL}>逻辑库名</label><input id="real-db-name" className={FIELD} disabled={busy} value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" /></div>
              <div><label htmlFor="real-db-charset" className={LABEL}>字符集</label><SelectDropdown id="real-db-charset" ariaLabel="字符集" fullWidth disabled={busy} items={CHARSET_ITEMS} value={charset} onSelect={setCharset} /></div>
            </div>}
          </section>

          <section aria-labelledby="db-account-title" className="border-t border-line pt-5">
            <h3 id="db-account-title" className="mb-3 text-sm font-semibold text-fg">{targetKind === 'existing' && selectedContainer && !selectedContainer.managed ? '现有普通账号' : '普通账号'}</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><label htmlFor="real-db-user" className={LABEL}>账号名</label><input id="real-db-user" className={FIELD} disabled={busy} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" /></div>
              <div><label htmlFor="real-db-password" className={LABEL}>密码{targetKind === 'new' ? '（至少 12 位）' : ''}</label>
                <div className="flex min-w-0 gap-2">
                  <div className="relative min-w-0 flex-1">
                    <input id="real-db-password" type={passwordVisible ? 'text' : 'password'} className={FIELD + ' pr-9'} disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
                    <PasswordVisibilityButton visible={passwordVisible} onToggle={setPasswordVisible} />
                  </div>
                  <button type="button" disabled={busy} onClick={() => setPassword(generateDemoPassword(24))} className={BUTTON + ' min-w-16 shrink-0 whitespace-nowrap'}>生成</button>
                </div>
              </div>
            </div>
            {targetKind === 'existing' && selectedContainer && !selectedContainer.managed ? <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div><label htmlFor="real-db-admin" className={LABEL}>已有管理员账号</label><input id="real-db-admin" className={FIELD} disabled={busy} value={adminUsername} onChange={(event) => setAdminUsername(event.target.value)} /></div>
              <div>
                <label htmlFor="real-db-admin-password" className={LABEL}>管理员密码</label>
                <div className="relative">
                  <input id="real-db-admin-password" type={adminPasswordVisible ? 'text' : 'password'} className={FIELD + ' pr-9'} disabled={busy} value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} autoComplete="new-password" />
                  <PasswordVisibilityButton visible={adminPasswordVisible} onToggle={setAdminPasswordVisible} />
                </div>
              </div>
            </div> : null}
          </section>

          {discoverError ? <div role="alert" className="rounded-lg border border-danger/40 p-3 text-xs text-danger">{discoverError}<button type="button" className={BUTTON + ' ml-2'} onClick={() => void discover()}>重试</button></div> : null}
          {createError ? <p role="alert" className="text-xs text-danger">{createError}</p> : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
          <p className="text-xs text-fg-subtle">{hint}</p>
          <div className="ml-auto flex gap-2">
            <button type="button" disabled={busy} onClick={close} className={BUTTON}>取消</button>
            <button type="button" disabled={!canSubmit} onClick={submit} className={BUTTON + ' bg-surface-raised'}>
              {creating ? <Loader2 aria-hidden size={13} className="mr-1.5 animate-spin" /> : null}
              {creating ? '处理中…' : targetKind === 'new' ? '创建并启动' : selectedContainer?.managed ? '创建逻辑库' : '验证并接管'}
            </button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
