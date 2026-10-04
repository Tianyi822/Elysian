import { useEffect, useState } from 'react'
import { Download, Search } from '../../components/icons'
import type { ContainerStatus } from '@elysian/contracts'
import { CONTAINER_STATUS_LABELS } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { RefreshButton } from '../../components/RefreshState'
import { CTL_CHIP, CTL_FIELD, CTL_PRIMARY, CTL_TOOLBAR } from '../../components/formControl'
import { DependencyGuideDialogs } from '../platform/DependencyGuideDialogs'
import { CONTAINER_LIVE_RECONNECT_MESSAGE } from './containerCopy'
import { useContainersStore } from '../../stores/containersStore'
import { useDependencyGuideStore } from '../../stores/dependencyGuideStore'
import { ContainerAppsPanel } from './ContainerAppsPanel'
import { ContainerCard } from './ContainerCard'
import { ContainerCreateDialog } from './ContainerCreateDialog'
import { ContainerDetailSheet } from './ContainerDetailSheet'
import { ImagePullDialog } from './ImagePullDialog'
import { ImageTable } from './ImageTable'
import { TerminalWindow } from './TerminalWindow'

const STATUS_FILTERS: ReadonlyArray<{ value: ContainerStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'running', label: CONTAINER_STATUS_LABELS.running },
  { value: 'stopped', label: CONTAINER_STATUS_LABELS.stopped },
  { value: 'restarting', label: CONTAINER_STATUS_LABELS.restarting },
  { value: 'paused', label: CONTAINER_STATUS_LABELS.paused },
]

export function ContainerPage() {
  const gateway = useGateway()
  const status = useContainersStore((s) => s.status)
  const errorMessage = useContainersStore((s) => s.errorMessage)
  const containers = useContainersStore((s) => s.containers)
  const statusFilter = useContainersStore((s) => s.statusFilter)
  const search = useContainersStore((s) => s.search)
  const view = useContainersStore((s) => s.view)
  const liveStatus = useContainersStore((s) => s.liveStatus)
  const images = useContainersStore((s) => s.images)
  const imageRefreshStatus = useContainersStore((s) => s.imageRefreshStatus)
  const refreshImages = useContainersStore((s) => s.refreshImages)
  const load = useContainersStore((s) => s.load)
  const check = useDependencyGuideStore((s) => s.check)
  const setStatusFilter = useContainersStore((s) => s.setStatusFilter)
  const setSearch = useContainersStore((s) => s.setSearch)
  const openCreate = useContainersStore((s) => s.openCreate)
  // 拉取弹窗只在镜像视图用，开关留在页面本地即可，不入全局 store。
  const [pullOpen, setPullOpen] = useState(false)

  useEffect(() => {
    void load(gateway)
    // 依赖检测幂等：切页重挂不重探，报告由引导层消费。
    void check(gateway)
  }, [gateway, load, check])

  // 文件工作区不依赖 Docker Engine 就绪；引擎错误只影响容器、镜像与构建。
  if (view === 'apps') {
    return (
      <div className="mb-6">
        <ContainerAppsPanel />
        <DependencyGuideDialogs scope="docker-dependent" reload={() => void load(gateway)} />
      </div>
    )
  }

  if (status !== 'ready') {
    return (
      <>
        {status === 'error' ? (
          <ErrorState
            title="容器数据加载失败"
            description={errorMessage}
            onRetry={() => void load(gateway)}
          />
        ) : (
          <LoadingState label="正在加载容器数据…" />
        )}
        {/* Docker 未就绪时弹窗叠加在错误态 / 加载态之上，引导层与状态层各说各的。 */}
        <DependencyGuideDialogs scope="docker-dependent" reload={() => void load(gateway)} />
      </>
    )
  }

  const keyword = search.trim().toLowerCase()
  const filtered = containers.filter(
    (container) =>
      (statusFilter === 'all' || container.status === statusFilter) &&
      container.name.toLowerCase().includes(keyword),
  )

  return (
    <div className="mb-6">
      {liveStatus === 'connecting' ? (
        <p
          role="status"
          className="mb-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          {CONTAINER_LIVE_RECONNECT_MESSAGE}
        </p>
      ) : null}
      {view === 'grid' ? (
        <div className={`${CTL_TOOLBAR} container-toolbar mb-4 flex flex-wrap items-center gap-4 panel-surface px-4 py-3`}>
          <div role="group" aria-label="状态筛选" className="flex flex-wrap basis-full gap-2 lg:basis-auto">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                aria-pressed={statusFilter === filter.value}
                onClick={() => setStatusFilter(filter.value)}
                className={CTL_CHIP}
              >
                {filter.label}
              </button>
            ))}
          </div>
          {/* 窄屏两行：筛选 chip 一行，搜索框与创建容器一行（搜索撑开）；lg 起回到一行三段。 */}
          <div className="relative min-w-32 flex-1 lg:w-56 lg:flex-none">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            />
            <label htmlFor="container-search" className="sr-only">
              搜索容器名称
            </label>
            <input
              id="container-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索容器名称"
              className={`${CTL_FIELD} rounded-full pl-8`}
            />
          </div>
          <button
            type="button"
            onClick={() => openCreate()}
            className={`${CTL_PRIMARY} ml-auto`}
          >
            创建容器
          </button>
        </div>
      ) : null}

      {view === 'images' ? (
        <>
          <div className={`${CTL_TOOLBAR} container-toolbar mb-4 flex flex-wrap items-center justify-between gap-4 panel-surface px-4 py-3`}>
            <p className="text-xs text-fg-muted">共 {images.length} 个镜像</p>
            <div className="flex flex-wrap items-center gap-2">
              <RefreshButton
                onPress={() => void refreshImages(gateway)}
                busy={imageRefreshStatus === 'loading'}
                label="刷新镜像"
                formControl
              />
              <button type="button" onClick={() => setPullOpen(true)} className={CTL_PRIMARY}>
                <Download aria-hidden size={14} />拉取镜像
              </button>
            </div>
          </div>
          <ImageTable images={images} containers={containers} busy={imageRefreshStatus === 'loading'} />
        </>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={containers.length === 0 ? '还没有容器' : '没有匹配的容器'}
          description={
            containers.length === 0
              ? isDockerRuntime()
                ? '这台机器上还没有容器。'
                : '当前演示数据集没有容器。可以刷新重试。'
              : '换个筛选条件或清空搜索词再试。'
          }
        />
      ) : (
        <ul aria-label="容器列表" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-4">
          {filtered.map((container) => (
            <li key={container.id} aria-label={container.name} className="h-full">
              <ContainerCard container={container} />
            </li>
          ))}
        </ul>
      )}

      <ContainerCreateDialog />
      {pullOpen ? <ImagePullDialog onClose={() => setPullOpen(false)} /> : null}
      <ContainerDetailSheet />
      <TerminalWindow />
      <DependencyGuideDialogs scope="docker-dependent" reload={() => void load(gateway)} />
    </div>
  )
}
