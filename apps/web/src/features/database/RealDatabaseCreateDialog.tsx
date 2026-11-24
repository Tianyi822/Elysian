import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useState } from 'react'
import type { ContainerImage, DatabaseContainerEngine, ImagePullProgress } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { DIALOG_FORM_ACTION_CLASS, DIALOG_FORM_FIELD_CLASS, DIALOG_FORM_LABEL_CLASS, FORM_CONTROL_HEIGHT_CLASS } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { X } from '../../components/icons'
import { LoadingOrb } from '../../components/LoadingOrb'
import { useDatabaseStore } from '../../stores/databaseStore'
import { useContainersStore } from '../../stores/containersStore'
import { formatBytes } from '../../utils/formatBytes'
import { readStoredImageRegistry, writeStoredImageRegistry } from '../../utils/imagePullPreferences'
import { CUSTOM_REGISTRY_ID, matchRegistryPreset } from '../../utils/imageRegistryPresets'
import { DEFAULT_IMAGE_REGISTRY, registryHost, validateRegistryUrl } from '../../utils/imageReference'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'
import { Button } from '../../components/Button'
import type { ImageRegistryPreset } from '../../contracts/adapters'
import { captureAuthGeneration } from '../../utils/authGeneration'

/**
 * 添加数据库容器：镜像版本查询与拉取复用容器域既有接缝（imageTags / pullImage），
 * 镜像源走 imageRegistryPresets 与 imagePullPreferences 的共享出口，不自带独立的
 * 「自定义镜像源地址」输入。管理员凭据由服务端生成并存入登记，表单不收集任何账号；
 * 接管（adopt）与逻辑库概念已退役，这里只新建容器。
 */

type Scope = 'localhost' | 'container-network' | 'any-host'

const VERSION_PATTERN = /^\d+(?:\.\d+){0,2}(?:[-.][A-Za-z0-9]+)*$/
const FIELD = DIALOG_FORM_FIELD_CLASS + ' disabled:opacity-60'
const ACCESS_SCOPE_ITEMS = [
  { value: 'localhost', label: '仅宿主回环' },
  { value: 'container-network', label: '容器网络内' },
  { value: 'any-host', label: '任意主机' },
] as const

/** 本地是否已有该仓库:标签的镜像：官方仓库名三形态都接受，与镜像判定口径同源。 */
function imageHasTag(image: ContainerImage, repo: string, tag: string): boolean {
  const names = [repo, 'library/' + repo, 'docker.io/library/' + repo]
  return (names.includes(image.name) && image.tag === tag) ||
    (image.otherTags ?? []).some((ref) => names.some((name) => ref === name + ':' + tag))
}

function pullBytes(bytes: number): string {
  return formatBytes(bytes, { unit: 'legacy', digits: { byte: 'round', kilo: 'round' }, maxUnit: 'mega' })
}

function pullPhase(progress?: ImagePullProgress): string {
  switch (progress?.phase) {
    case 'downloading': return '下载镜像层'
    case 'extracting': return '解压镜像层'
    case 'finalizing': return '正在校验并写入镜像'
    default: return '正在准备镜像层'
  }
}

export function RealDatabaseCreateDialog({ engine }: { engine: DatabaseContainerEngine }) {
  const gateway = useGateway()
  const close = useDatabaseStore((state) => state.closeCreate)
  const create = useDatabaseStore((state) => state.createDatabase)
  const refreshAfterMutation = useDatabaseStore((state) => state.refreshAfterMutation)
  const creating = useDatabaseStore((state) => state.creating)
  const createError = useDatabaseStore((state) => state.createError)
  const images = useContainersStore((state) => state.images)
  const activePull = useContainersStore((state) => state.pullingImage)
  const pullImage = useContainersStore((state) => state.pullImage)

  const [presets, setPresets] = useState<readonly ImageRegistryPreset[]>([])
  const [presetsLoading, setPresetsLoading] = useState(true)
  const [registryAddress, setRegistryAddress] = useState(() => readStoredImageRegistry() || DEFAULT_IMAGE_REGISTRY)
  // 与镜像页同款：选了「自定义地址」就固定在自定义形态，空地址也不弹回官方预设。
  const [forceCustom, setForceCustom] = useState(false)
  const [customAddress, setCustomAddress] = useState(readStoredImageRegistry)
  const [versionTag, setVersionTag] = useState('')
  const [tags, setTags] = useState<readonly string[]>([])
  const [tagStatus, setTagStatus] = useState<'idle' | 'loading' | 'unavailable'>('idle')
  const [pullError, setPullError] = useState('')
  const [pullComplete, setPullComplete] = useState(false)
  const [containerName, setContainerName] = useState('elysian-' + engine.toLowerCase())
  const [scope, setScope] = useState<Scope>('localhost')
  const [hostPort, setHostPort] = useState('')
  const [confirmPublic, setConfirmPublic] = useState(false)
  useFeedbackMessage(pullError)
  useFeedbackMessage(pullComplete ? '镜像已拉取，可以继续创建。' : null, 'success')

  const repo = engine.toLowerCase()
  const validVersion = VERSION_PATTERN.test(versionTag) && !/latest/i.test(versionTag)
  const image = validVersion ? images.find((candidate) => imageHasTag(candidate, repo, versionTag)) : undefined
  const registryError = registryAddress.trim() ? validateRegistryUrl(registryAddress) : undefined
  const registry = registryAddress.trim() || DEFAULT_IMAGE_REGISTRY
  const presetId = forceCustom ? CUSTOM_REGISTRY_ID : matchRegistryPreset(presets, registryAddress)?.id ?? CUSTOM_REGISTRY_ID
  const pullRegistry = registryAddress.trim() || undefined
  const pulling = activePull?.name === repo && activePull.tag === versionTag && activePull.registry === pullRegistry
  const progress = pulling ? activePull.progress : undefined
  const busy = pulling || creating

  // 镜像源预设目录与镜像页共用同一出口；读取失败时仍可手填地址。
  useEffect(() => {
    const controller = new AbortController()
    setPresetsLoading(true)
    void gateway.containers.listRegistryPresets(controller.signal)
      .then((items) => { if (!controller.signal.aborted) setPresets(items) })
      .catch(() => { /* 目录不可用：保留默认官方地址与已存偏好。 */ })
      .finally(() => { if (!controller.signal.aborted) setPresetsLoading(false) })
    return () => controller.abort()
  }, [gateway])
  useEffect(() => { writeStoredImageRegistry(registryAddress) }, [registryAddress])

  // 版本标签查询（300ms 防抖）：目录不可用时仍可手动输入。
  useEffect(() => {
    const controller = new AbortController()
    setTags([])
    if (registryError) { setTagStatus('idle'); return () => controller.abort() }
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
  }, [gateway, repo, registryAddress, registryError])

  const pull = async () => {
    if (activePull || !validVersion || registryError || image) return
    const auth = captureAuthGeneration()
    setPullError('')
    setPullComplete(false)
    const result = await pullImage(gateway, { name: repo, tag: versionTag, registry: pullRegistry }, {
      confirmInventory: () => refreshAfterMutation(gateway, 'container'),
    })
    if (auth !== captureAuthGeneration()) return
    if (result.status === 'succeeded') setPullComplete(true)
    if (result.status === 'failed') setPullError(result.error)
  }

  const validContainerName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(containerName)
  const validPort = Number.isInteger(Number(hostPort)) && Number(hostPort) >= 1 && Number(hostPort) <= 65535
  const ready = validVersion && Boolean(image) && validContainerName && (scope !== 'any-host' || (validPort && confirmPublic))
  const canSubmit = !busy && ready
  const hint = !validVersion ? '请填写明确的数字版本标签'
    : !image ? '请先拉取镜像'
      : !validContainerName ? '请填写有效的容器名称'
        : scope === 'any-host' && (!validPort || !confirmPublic) ? '请填写端口并确认公开访问' : ''

  const submit = () => {
    if (!canSubmit || !image) return
    void create(gateway, {
      kind: 'container', engine, versionTag, containerName, imageId: image.id, accessScope: scope,
      hostPort: scope === 'any-host' ? Number(hostPort) : undefined,
      confirmPublic: scope === 'any-host' ? confirmPublic : undefined,
    })
  }

  const tagItems = [
    ...(validVersion && !tags.includes(versionTag) ? [{ value: versionTag, label: versionTag + '（当前输入）' }] : []),
    ...tags.map((tag) => ({ value: tag, label: tag })),
  ]
  const sourceItems = [
    ...presets.map((preset) => ({ value: preset.id, label: preset.label, description: preset.note })),
    { value: CUSTOM_REGISTRY_ID, label: '自定义地址…', description: presetId === CUSTOM_REGISTRY_ID && customAddress.trim() ? registryHost(customAddress) : undefined },
  ]

  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) close() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
      <Dialog.Content aria-describedby={undefined} onPointerDownOutside={(event) => event.preventDefault()}
        className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(44rem,calc(100vh-2rem))] w-[min(42rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden panel-surface shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
          <Dialog.Title className="truncate text-base font-semibold text-fg">添加 {engine} 数据库</Dialog.Title>
          <Button variant="ghost" size="icon" type="button" disabled={busy} onClick={close} aria-label="关闭弹窗" className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-raised disabled:opacity-50"><X aria-hidden size={16} /></Button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <section aria-labelledby="db-image-title">
            <h3 id="db-image-title" className="mb-3 text-sm font-semibold text-fg">镜像与版本</h3>
            <div>
              <label htmlFor="real-db-registry" className={DIALOG_FORM_LABEL_CLASS}>镜像源</label>
              <SelectDropdown id="real-db-registry" ariaLabel="镜像源" fullWidth
                disabled={busy}
                items={sourceItems}
                value={presetId}
                fallbackLabel="选择镜像源"
                onSelect={(next) => {
                  setForceCustom(next === CUSTOM_REGISTRY_ID)
                  setRegistryAddress(next === CUSTOM_REGISTRY_ID ? customAddress : presets.find((preset) => preset.id === next)?.url ?? registryAddress)
                }} />
              {presetsLoading ? <p role="status" className="mt-1.5 text-xs text-fg-muted">正在读取镜像源…</p> : null}
              {presetId === CUSTOM_REGISTRY_ID && !presetsLoading ? <div className="mt-3">
                <label htmlFor="real-db-registry-custom" className={DIALOG_FORM_LABEL_CLASS}>自定义镜像源地址</label>
                <input id="real-db-registry-custom" className={FIELD + ' font-mono'} disabled={busy} value={customAddress} onChange={(event) => { setCustomAddress(event.target.value); setRegistryAddress(event.target.value) }} placeholder="留空使用官方地址 registry-1.docker.io" autoComplete="off" spellCheck={false} />
                {registryError ? <p role="alert" className="mt-1 text-xs text-danger">{registryError}</p> : null}
              </div> : null}
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div><span className={DIALOG_FORM_LABEL_CLASS}>镜像名称</span><p className={FIELD + ' flex items-center font-mono'} aria-label="镜像名称">{repo}</p></div>
              <div>
                <label htmlFor="real-db-version" className={DIALOG_FORM_LABEL_CLASS}>版本标签（不支持 latest）</label>
                <div className="flex min-w-0 gap-2">
                  <input id="real-db-version" className={FIELD + ' min-w-0 flex-1 font-mono'} disabled={busy} value={versionTag} onChange={(event) => { setVersionTag(event.target.value.trim()); setPullComplete(false); setPullError('') }} placeholder={engine === 'MariaDB' ? '例如 11.4' : engine === 'MySQL' ? '例如 8.4' : '例如 7.4'} autoComplete="off" spellCheck={false} />
                  <SelectDropdown ariaLabel="版本标签建议" disabled={busy || tags.length === 0} items={tagItems} value={undefined} onSelect={(tag) => { setVersionTag(tag); setPullComplete(false); setPullError('') }} fallbackLabel="选择版本" triggerClassName={`inline-flex ${FORM_CONTROL_HEIGHT_CLASS} shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-control-line bg-surface-raised px-2 text-xs text-fg disabled:opacity-50`} />
                </div>
                {versionTag && !validVersion ? <p role="alert" className="mt-1 text-xs text-danger">请输入明确的数字版本标签</p> : null}
                {tagStatus === 'loading' ? <p role="status" className="mt-1 text-xs text-fg-subtle">正在查询版本…</p> : null}
                {tagStatus === 'unavailable' ? <p className="mt-1 text-xs text-fg-subtle">版本列表不可用，可手动输入。</p> : null}
              </div>
            </div>
            {validVersion && !registryError ? <div className="mt-4 rounded-lg border border-control-line bg-surface-raised px-3 py-2 text-xs">
              <span className="text-fg-muted">{image ? '本地镜像 ' : '将拉取 '}</span><span className="break-all font-mono text-fg">{image ? repo + ':' + versionTag : registryHost(registry) + '/' + repo + ':' + versionTag}</span>
            </div> : null}
            {validVersion && !registryError ? image ? <p role="status" className="mt-2 text-xs text-success">本地镜像已就绪：{repo}:{versionTag}</p> : <div className="mt-2 rounded-lg border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-fg-muted">本地尚无 {repo}:{versionTag} 镜像</p>
                <Button variant="outline" type="button" disabled={busy || Boolean(activePull) || Boolean(registryError)} onClick={() => void pull()} className={DIALOG_FORM_ACTION_CLASS}>{pulling ? '拉取中…' : '拉取镜像'}</Button>
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
          </section>

          <section aria-labelledby="db-container-title" className="border-t border-line pt-5">
            <h3 id="db-container-title" className="mb-3 text-sm font-semibold text-fg">容器与访问</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><label htmlFor="real-db-container" className={DIALOG_FORM_LABEL_CLASS}>新容器名称</label><input id="real-db-container" className={FIELD} disabled={busy} value={containerName} onChange={(event) => setContainerName(event.target.value)} /></div>
              <div><label htmlFor="real-db-scope" className={DIALOG_FORM_LABEL_CLASS}>访问范围</label><SelectDropdown id="real-db-scope" ariaLabel="访问范围" fullWidth disabled={busy} items={ACCESS_SCOPE_ITEMS} value={scope} onSelect={setScope} /></div>
            </div>
            {scope === 'any-host' ? <div className="mt-4 space-y-3">
              <div><label htmlFor="real-db-port" className={DIALOG_FORM_LABEL_CLASS}>宿主端口</label><input id="real-db-port" type="number" min="1" max="65535" className={FIELD} disabled={busy} value={hostPort} onChange={(event) => setHostPort(event.target.value)} /></div>
              <label className="flex items-start gap-2 text-xs leading-5 text-warning"><input type="checkbox" className="mt-0.5" disabled={busy} checked={confirmPublic} onChange={(event) => setConfirmPublic(event.target.checked)} />确认数据库端口将监听所有宿主网卡</label>
              <p className="text-xs text-fg-subtle">创建成功后将自动在防火墙开放该端口。</p>
            </div> : null}
            <p className="mt-4 text-xs text-fg-subtle">管理员账号与密码由面板生成并存入登记，创建完成后在卡片上点击复制读取。</p>
          </section>

          {createError ? <p role="alert" className="text-xs text-danger">{createError}</p> : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
          <p className="text-xs text-fg-subtle">{hint}</p>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" type="button" disabled={busy} onClick={close} className={DIALOG_FORM_ACTION_CLASS}>取消</Button>
            <Button variant="outline" type="button" disabled={!canSubmit} onClick={submit} className={DIALOG_FORM_ACTION_CLASS + ' bg-surface-raised'}>
              {creating ? <LoadingOrb size={13} className="mr-1.5" /> : null}
              {creating ? '处理中…' : '创建并启动'}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
