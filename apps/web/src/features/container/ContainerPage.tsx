import * as Tooltip from '@radix-ui/react-tooltip'
import { useEffect, useState } from 'react'
import { Download } from '../../components/icons'
import { SearchInput } from '../../components/SearchInput'
import type { ContainerStatus } from '@elysian/contracts'
import { CONTAINER_STATUS_LABELS } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { RefreshButton } from '../../components/RefreshState'
import { CTL_TOOLBAR } from '../../components/formControl'
import { Button } from '../../components/Button'
import { ChipGroup } from '../../components/ChipGroup'
import { TableCreateButton } from '../../components/TableCreateButton'
import { DockerDependencyEntry } from './DockerDependencyEntry'
import { CONTAINER_LIVE_RECONNECT_MESSAGE } from '../../utils/containerCopy'
import { useContainersStore } from '../../stores/containersStore'
import { useDependencyProbeStore } from '../../stores/dependencyProbeStore'
import { ContainerAppsPanel } from './ContainerAppsPanel'
import { ContainerCard } from './ContainerCard'
import { ContainerCreateDialog } from './ContainerCreateDialog'
import { ContainerDetailSheet } from '../../components/ContainerDetailSheet'
import { ImagePullDialog } from './ImagePullDialog'
import { ImageTable } from './ImageTable'
import { TerminalWindow } from './TerminalWindow'
import './containerToolbar.css'

const STATUS_FILTERS: ReadonlyArray<{ value: ContainerStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'running', label: CONTAINER_STATUS_LABELS.running },
  { value: 'stopped', label: CONTAINER_STATUS_LABELS.stopped },
  { value: 'restarting', label: CONTAINER_STATUS_LABELS.restarting },
  { value: 'paused', label: CONTAINER_STATUS_LABELS.paused },
]

function ImagePullButton({ onPress }: { onPress: () => void }) {
  const label = '拉取镜像'
  return <Tooltip.Root>
    <Tooltip.Trigger asChild>
      <Button type="button" onClick={onPress} aria-label={label}
        className="image-pull-button h-[var(--dt-control-height)] whitespace-nowrap text-xs"
        leftIcon={<Download aria-hidden size={14} />}>
        <span className="image-pull-label">{label}</span>
      </Button>
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content side="bottom" sideOffset={6} className="z-[80] rounded border border-control-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg">
        {label}<Tooltip.Arrow className="fill-surface-raised" />
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
}

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
  const check = useDependencyProbeStore((s) => s.check)
  const setStatusFilter = useContainersStore((s) => s.setStatusFilter)
  const setSearch = useContainersStore((s) => s.setSearch)
  const openCreate = useContainersStore((s) => s.openCreate)
  // 拉取弹窗只在镜像视图用，开关留在页面本地即可，不入全局 store。
  const [pullOpen, setPullOpen] = useState(false)

  useEffect(() => {
    void load(gateway)
    // 依赖检测幂等：切页重挂不重探，报告由探测层消费。
    void check(gateway)
  }, [gateway, load, check])

  // 文件工作区不依赖 Docker Engine 就绪；引擎错误只影响容器、镜像与构建。
  if (view === 'apps') {
    return (
      <div className="mb-6">
        <DockerDependencyEntry className="mb-4" onReady={() => load(gateway)} />
        <ContainerAppsPanel />
      </div>
    )
  }

  if (status !== 'ready') {
    return (
      <>
        <DockerDependencyEntry className="mb-4" onReady={() => load(gateway)} />
        {status === 'error' ? (
          <ErrorState
            title="容器数据加载失败"
            description={errorMessage}
            onRetry={() => void load(gateway)}
          />
        ) : (
          <LoadingState label="正在加载容器数据…" />
        )}
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
      {errorMessage ? <p role="alert" className="mb-3 text-xs text-danger">刷新失败：{errorMessage}。已保留上次读取结果。<Button variant="link" type="button" className="ml-2 underline" onClick={() => void load(gateway)}>重试</Button></p> : null}
      {liveStatus === 'connecting' ? (
        <p
          role="status"
          className="mb-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          {CONTAINER_LIVE_RECONNECT_MESSAGE}
        </p>
      ) : null}
      {view === 'grid' ? (
        <div className={`${CTL_TOOLBAR} rect-toolbar container-grid-toolbar mb-4 panel-surface px-3 py-3 sm:px-4`}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <ChipGroup ariaLabel="状态筛选" items={STATUS_FILTERS} value={statusFilter} onSelect={setStatusFilter}
              className="items-start" />
            <div className="container-grid-toolbar-actions">
              <SearchInput id="container-search" label="搜索容器名称" value={search} onChange={setSearch} />
              <TableCreateButton label="创建容器" onPress={openCreate} />
            </div>
          </div>
          <DockerDependencyEntry className="mt-2" onReady={() => load(gateway)} />
        </div>
      ) : null}

      {view === 'images' ? (
        <>
          <DockerDependencyEntry className="mb-3" onReady={() => load(gateway)} />
          <ImageTable images={images} containers={containers} busy={imageRefreshStatus === 'loading'}
            searchAction={<RefreshButton onPress={() => void refreshImages(gateway)}
              busy={imageRefreshStatus === 'loading'} label="刷新镜像" className="dt-toolbar-control-icon" />}
            toolbar={<ImagePullButton onPress={() => setPullOpen(true)} />}
          />
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
    </div>
  )
}
