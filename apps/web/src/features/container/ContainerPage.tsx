import { useEffect, useState } from 'react'
import { Download, RotateCw, Search } from '../../components/icons'
import type { ContainerStatus } from '@elysian/contracts'
import { CONTAINER_STATUS_LABELS } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { DependencyGuideDialogs } from '../platform/DependencyGuideDialogs'
import { CONTAINER_LIVE_RECONNECT_MESSAGE } from './containerCopy'
import { useContainersStore } from '../../stores/containersStore'
import { useDependencyGuideStore } from '../../stores/dependencyGuideStore'
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
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
          <div role="group" aria-label="状态筛选" className="flex flex-wrap basis-full gap-1 lg:basis-auto">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                aria-pressed={statusFilter === filter.value}
                onClick={() => setStatusFilter(filter.value)}
                className={[
                  'rounded-lg border px-2.5 py-1 text-xs transition-colors',
                  statusFilter === filter.value
                    ? 'border-accent/50 bg-accent/10 font-medium text-accent'
                    : 'border-line text-fg-muted hover:bg-surface-raised hover:text-fg',
                ].join(' ')}
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
              className="w-full rounded-lg border border-line bg-surface-raised py-1.5 pl-8 pr-3 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle"
            />
          </div>
          <button
            type="button"
            onClick={() => openCreate()}
            className="ml-auto inline-flex items-center rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle"
          >
            创建容器
          </button>
        </div>
      ) : null}

      {view === 'images' ? (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
            <p className="text-xs text-fg-muted">共 {images.length} 个镜像</p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void refreshImages(gateway)}
                disabled={imageRefreshStatus === 'loading'}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCw aria-hidden size={14} className={imageRefreshStatus === 'loading' ? 'animate-spin' : undefined} />刷新镜像
              </button>
              <button type="button" onClick={() => setPullOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle">
                <Download aria-hidden size={14} />拉取镜像
              </button>
            </div>
          </div>
          <ImageTable images={images} containers={containers} />
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
        <ul aria-label="容器列表" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
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
