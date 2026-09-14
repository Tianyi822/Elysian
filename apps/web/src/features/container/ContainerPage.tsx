import { useEffect } from 'react'
import type { ContainerStatus } from '@elysian/contracts'
import { CONTAINER_STATUS_LABELS } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { useContainersStore } from '../../stores/containersStore'
import { ContainerCard } from './ContainerCard'
import { ContainerDetailSheet } from './ContainerDetailSheet'
import { ImageTable } from './ImageTable'
import { TerminalWindow } from './TerminalWindow'

const STATUS_FILTERS: ReadonlyArray<{ value: ContainerStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'running', label: CONTAINER_STATUS_LABELS.running },
  { value: 'stopped', label: CONTAINER_STATUS_LABELS.stopped },
  { value: 'restarting', label: CONTAINER_STATUS_LABELS.restarting },
]

export function ContainerPage() {
  const gateway = useGateway()
  const status = useContainersStore((s) => s.status)
  const errorMessage = useContainersStore((s) => s.errorMessage)
  const containers = useContainersStore((s) => s.containers)
  const statusFilter = useContainersStore((s) => s.statusFilter)
  const search = useContainersStore((s) => s.search)
  const view = useContainersStore((s) => s.view)
  const images = useContainersStore((s) => s.images)
  const load = useContainersStore((s) => s.load)
  const setView = useContainersStore((s) => s.setView)
  const setStatusFilter = useContainersStore((s) => s.setStatusFilter)
  const setSearch = useContainersStore((s) => s.setSearch)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  if (status !== 'ready') {
    if (status === 'error') {
      return (
        <ErrorState
          title="容器数据加载失败"
          description={errorMessage}
          onRetry={() => void load(gateway)}
        />
      )
    }
    return <LoadingState label="正在加载容器数据…" />
  }

  const keyword = search.trim().toLowerCase()
  const filtered = containers.filter(
    (container) =>
      (statusFilter === 'all' || container.status === statusFilter) &&
      container.name.toLowerCase().includes(keyword),
  )

  return (
    <div className="mb-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div role="group" aria-label="视图切换" className="inline-flex overflow-hidden rounded-lg border border-line">
          <button
            type="button"
            aria-pressed={view === 'grid'}
            onClick={() => setView('grid')}
            className={`px-3 py-1.5 text-xs transition-colors ${
              view === 'grid' ? 'bg-surface-raised font-medium text-fg' : 'text-fg-muted hover:text-fg'
            }`}
          >
            容器
          </button>
          <button
            type="button"
            aria-pressed={view === 'images'}
            onClick={() => setView('images')}
            className={`border-l border-line px-3 py-1.5 text-xs transition-colors ${
              view === 'images' ? 'bg-surface-raised font-medium text-fg' : 'text-fg-muted hover:text-fg'
            }`}
          >
            镜像
          </button>
        </div>
        {view === 'grid' ? (
          <>
            <div role="group" aria-label="状态筛选" className="flex flex-wrap gap-1">
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
                      : 'border-line bg-surface text-fg-muted hover:text-fg',
                  ].join(' ')}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <div className="ml-auto">
              <label htmlFor="container-search" className="sr-only">
                搜索容器名称
              </label>
              <input
                id="container-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索容器名称"
                className="w-56 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-fg-subtle"
              />
            </div>
          </>
        ) : null}
      </div>

      {view === 'images' ? (
        <ImageTable images={images} containers={containers} />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={containers.length === 0 ? '还没有容器' : '没有匹配的容器'}
          description={
            containers.length === 0
              ? '当前演示数据集没有容器。可以刷新重试，或在快捷操作里重置演示数据。'
              : '换个筛选条件或清空搜索词再试。'
          }
        />
      ) : (
        <ul aria-label="容器列表" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((container) => (
            <li key={container.id} aria-label={container.name} className="h-full">
              <ContainerCard container={container} />
            </li>
          ))}
        </ul>
      )}

      <ContainerDetailSheet />
      <TerminalWindow />
    </div>
  )
}
