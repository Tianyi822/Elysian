import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useState } from 'react'
import { Loader2, Plus, X } from '../../components/icons'
import { validateContainerAppDisplayName, validateContainerAppSlug } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { CTL_FIELD, CTL_PRIMARY, CTL_SECONDARY, CTL_TOOLBAR } from '../../components/formControl'
import { useContainerAppsStore } from '../../stores/containerAppsStore'
import { ContainerAppEditorSheet } from './ContainerAppEditorSheet'
import { ContainerAppWorkspaceCard } from './ContainerAppWorkspaceCard'

/**
 * 容器应用工作区视图：随容器一起上传的配置文件（compose.yml、.env、挂载用的配置目录）
 * 的存放、真实路径回显、文本编辑与 compose 引用自检。
 *
 * 面板只落盘与给路径，不执行 docker compose、不做 docker build（ADR-0020）：
 * compose 自己声明要加载哪些文件，界面把文件放好并写出真实路径，改动由用户抄回 compose。
 */
export function ContainerAppsPanel() {
  const gateway = useGateway()
  const status = useContainerAppsStore((s) => s.status)
  const errorMessage = useContainerAppsStore((s) => s.errorMessage)
  const apps = useContainerAppsStore((s) => s.apps)
  const refreshing = useContainerAppsStore((s) => s.refreshing)
  const load = useContainerAppsStore((s) => s.load)
  const refresh = useContainerAppsStore((s) => s.refresh)
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<{ slug: string; path: string } | null>(null)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  const docker = isDockerRuntime()
  const fileCount = apps.reduce((total, app) => total + app.files.length, 0)

  // idle 也算加载：否则挂载那一帧会先闪空态，再被加载态盖回去。
  if (status !== 'ready') {
    if (status === 'error') {
      return (
        <ErrorState
          title="应用工作区加载失败"
          description={errorMessage}
          onRetry={() => void load(gateway)}
        />
      )
    }
    return <LoadingState label="正在加载应用工作区…" />
  }

  return (
    <div>
      <div className={`${CTL_TOOLBAR} mb-4 flex flex-wrap items-center justify-between gap-3 panel-surface px-4 py-3`}>
        <p className="min-w-0 flex-1 text-xs text-fg-muted">
          {docker
            ? `共 ${apps.length} 个工作区、${fileCount} 个文件。面板只保存文件并给出真实路径，compose 与挂载由容器自己按路径加载。`
            : `演示工作区只存在于内存，共 ${apps.length} 个；刷新回到空清单，给出的路径不代表宿主磁盘目录。`}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <RefreshButton onPress={() => void refresh(gateway)} busy={refreshing} label="刷新工作区" formControl />
          <button type="button" onClick={() => setCreateOpen(true)} className={CTL_PRIMARY}>
            <Plus aria-hidden size={14} />
            新建工作区
          </button>
        </div>
      </div>

      {/* 遮罩只盖清单本身：工具栏在遮罩外，刷新图标才不被自己引发的遮罩盖住。 */}
      <div className="busy-host">
        <BusyVeil busy={refreshing} />
        {apps.length === 0 ? (
          <EmptyState
            title="还没有应用工作区"
            description={
              docker
                ? '为需要一起上传配置文件的容器建一个工作区，上传 compose 与配置文件后，界面会给出可直接抄进配置的真实路径。'
                : '演示模式下这里不落盘，创建工作区只在内存里存一份文件清单。'
            }
            action={
              <button type="button" onClick={() => setCreateOpen(true)} className={`${CTL_SECONDARY} mt-1 px-2`}>
                新建工作区
              </button>
            }
          />
        ) : (
          <ul
            aria-label="应用工作区列表"
            className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,26rem),1fr))] items-start gap-4"
          >
            {apps.map((app) => (
              <ContainerAppWorkspaceCard
                key={app.slug}
                app={app}
                onEdit={(slug, path) => setEditing({ slug, path })}
              />
            ))}
          </ul>
        )}
      </div>

      {createOpen ? <CreateAppDialog onClose={() => setCreateOpen(false)} /> : null}
      {editing ? (
        <ContainerAppEditorSheet
          slug={editing.slug}
          path={editing.path}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  )
}

/** 新建工作区：标识即目录名，所以先校验再提交，展示名可留空回落到标识。 */
function CreateAppDialog({ onClose }: { onClose: () => void }) {
  const gateway = useGateway()
  const creating = useContainerAppsStore((s) => s.creating)
  const createError = useContainerAppsStore((s) => s.createError)
  const create = useContainerAppsStore((s) => s.create)
  const [slug, setSlug] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [showErrors, setShowErrors] = useState(false)

  const slugError = validateContainerAppSlug(slug)
  const nameError = validateContainerAppDisplayName(displayName)
  const blocked = Boolean(slugError || nameError)

  const submit = () => {
    setShowErrors(true)
    if (blocked) return
    void create(gateway, { slug, displayName }).then((ok) => {
      if (ok) onClose()
    })
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby="create-app-description"
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl"
        >
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title className="text-sm font-medium">新建应用工作区</Dialog.Title>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭弹窗"
              className="inline-flex size-7 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
            >
              <X aria-hidden size={15} />
            </button>
          </div>
          <p id="create-app-description" className="mt-1.5 text-xs text-fg-muted">
            标识会直接作为目录名，只能用小写字母、数字、下划线和连字符；建好后不能改名。
          </p>

          <div className="mt-3 space-y-3">
            <div>
              <label htmlFor="create-app-slug" className="mb-1 flex items-center gap-1 text-xs font-medium text-fg-muted">
                工作区标识<span className="text-danger">*</span>
              </label>
              <input
                id="create-app-slug"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="gateway-prod"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={showErrors && slugError ? 'create-app-slug-error' : undefined}
                className={`${CTL_FIELD} font-mono`}
              />
              {showErrors && slugError ? (
                <p id="create-app-slug-error" className="mt-1 text-xs text-danger">
                  {slugError}
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor="create-app-name" className="mb-1 block text-xs font-medium text-fg-muted">
                展示名（可选）
              </label>
              <input
                id="create-app-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="留空使用工作区标识"
                autoComplete="off"
                aria-describedby={showErrors && nameError ? 'create-app-name-error' : undefined}
                className={CTL_FIELD}
              />
              {showErrors && nameError ? (
                <p id="create-app-name-error" className="mt-1 text-xs text-danger">
                  {nameError}
                </p>
              ) : null}
            </div>
            {createError ? (
              <p role="alert" className="text-xs text-danger">
                {createError}
              </p>
            ) : null}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onClose} className={`${CTL_SECONDARY} px-3`}>
              取消
            </button>
            <button type="button" onClick={submit} disabled={creating} className={`${CTL_PRIMARY} gap-1.5 px-3`}>
              {creating ? <Loader2 aria-hidden size={13} className="animate-spin" /> : null}
              {creating ? '创建中…' : '创建工作区'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
