import { useEffect, useMemo } from 'react'
import type { DatabaseInstance } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { Button } from '../../components/Button'
import { ContainerDetailSheet } from '../../components/ContainerDetailSheet'
import { CTL_PRIMARY, CTL_TOOLBAR } from '../../components/formControl'
import { RefreshButton } from '../../components/RefreshState'
import { ErrorState, EmptyState, LoadingState } from '../../components/states/StateViews'
import { StaleDataBanner } from '../../components/states/StaleDataBanner'
import { useSilentPolling } from '../../components/useSilentPolling'
import { useContainersStore } from '../../stores/containersStore'
import { useDatabaseStore } from '../../stores/databaseStore'
import { useDependencyProbeStore } from '../../stores/dependencyProbeStore'
import { DatabaseContainerCard } from './DatabaseContainerCard'
import { DatabaseCreateDialog } from './DatabaseCreateDialog'
import { projectDatabaseCard } from './projectDatabaseCard'
import { SqliteFileCard } from './SqliteFileCard'

/** 数据库页：上部是按数据库镜像筛选的容器管理分区，下部是常驻的 SQLite 文件分区。 */
export function DatabasePage() {
  const gateway = useGateway()
  const status = useDatabaseStore((state) => state.status)
  const engine = useDatabaseStore((state) => state.tab)
  const databases = useDatabaseStore((state) => state.databases)
  const sqliteFiles = useDatabaseStore((state) => state.sqliteFiles)
  const containers = useContainersStore((state) => state.containers)
  const openContainerDetail = useContainersStore((state) => state.openDetail)
  const errorMessage = useDatabaseStore((state) => state.errorMessage)
  const refreshing = useDatabaseStore((state) => state.refreshing)
  const load = useDatabaseStore((state) => state.load)
  const openCreate = useDatabaseStore((state) => state.openCreate)
  const removingContainerIds = useDatabaseStore((state) => state.removingContainerIds)
  const removingSqliteIds = useDatabaseStore((state) => state.removingSqliteIds)
  const removeContainer = useDatabaseStore((state) => state.removeContainer)
  const removeSqliteFile = useDatabaseStore((state) => state.removeSqliteFile)
  const check = useDependencyProbeStore((state) => state.check)

  useEffect(() => {
    void load(gateway, { silent: true })
    // 依赖检测幂等：切页重挂不重探，报告由探测层消费。
    void check(gateway)
  }, [gateway, load, check])
  useSilentPolling(() => load(gateway, { silent: true }), { intervalMs: 15_000 })

  const containerById = useMemo(
    () => new Map(containers.map((container) => [container.id, container])),
    [containers],
  )

  const filtered = databases.filter((row) => row.engine === engine)

  return (
    <>
      <section aria-label="数据库实例" className="mb-6">
        {status === 'ready' && errorMessage ? <StaleDataBanner className="mb-3" error={errorMessage} onRetry={() => void load(gateway)} /> : null}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{engine} 数据库容器</h2>
          <div className={`${CTL_TOOLBAR} flex flex-wrap items-center gap-2`}>
            <RefreshButton onPress={() => void load(gateway)} busy={refreshing} />
            <Button variant="primary" type="button" disabled={status !== 'ready'} onClick={() => openCreate('container')} className={CTL_PRIMARY}>
              添加数据库
            </Button>
          </div>
        </div>
        {status === 'error' ? (
          <ErrorState title="数据库数据加载失败" description={errorMessage} onRetry={() => void load(gateway, { silent: true })} />
        ) : status !== 'ready' ? (
          <LoadingState label="正在加载数据库数据…" />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={`没有 ${engine} 数据库容器`}
            description="拉取镜像并创建新容器；本机已有数据库镜像的容器会自动出现在这里。"
          />
        ) : (
          /* 列数量内容区的实测宽度（容器查询）而非视口：侧边栏收展改变可用宽度，卡片随之增减，不会出现「空间变大卡片反而变小」的倒挂。 */
          <div className="@container">
            <ul
              aria-label={`${engine} 数据库容器列表`}
              className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-4"
            >
              {filtered.map((row) => (
                <li key={row.id} className="h-full">
                  <DatabaseContainerCard
                    row={row}
                    view={projectDatabaseCard(row, containerById)}
                    removing={removingContainerIds.includes(row.id)}
                    refreshing={refreshing}
                    onJump={() => openContainerDetail(row.containerId)}
                    onRemove={() => void removeContainer(gateway, row.id)}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <SqliteFilesSection
        files={sqliteFiles}
        removingIds={removingSqliteIds}
        onOpenCreate={() => openCreate('file')}
        onRemove={(fileId) => void removeSqliteFile(gateway, fileId)}
      />
      <DatabaseCreateDialog />
      <ContainerDetailSheet />
    </>
  )
}

/** SQLite 文件分区：与容器视图分开的固定分区，不占引擎页签。 */
function SqliteFilesSection({
  files,
  removingIds,
  onOpenCreate,
  onRemove,
}: {
  files: readonly DatabaseInstance[]
  removingIds: readonly string[]
  onOpenCreate(): void
  onRemove(fileId: string): void
}) {
  const gateway = useGateway()
  const status = useDatabaseStore((state) => state.sqliteStatus)
  const errorMessage = useDatabaseStore((state) => state.sqliteErrorMessage)
  const load = useDatabaseStore((state) => state.load)
  return (
    <section aria-label="SQLite 文件" className="mb-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">SQLite 文件</h2>
        <Button variant="primary" type="button" disabled={status !== 'ready'} onClick={onOpenCreate} className={CTL_PRIMARY}>
          添加 SQLite 文件
        </Button>
      </div>
      {status === 'ready' && errorMessage ? (
        <p role="alert" className="mb-3 text-xs text-danger">
          SQLite 文件刷新失败，已保留上次读取结果。{errorMessage}
          <Button variant="link" type="button" className="ml-2 underline" onClick={() => void load(gateway, { silent: true })}>重试</Button>
        </p>
      ) : null}
      {status === 'error' ? (
        <ErrorState title="SQLite 文件加载失败" description={errorMessage} onRetry={() => void load(gateway, { silent: true })} />
      ) : status !== 'ready' ? (
        <LoadingState label="正在加载 SQLite 文件…" />
      ) : files.length === 0 ? (
        <EmptyState
          title="没有 SQLite 文件"
          description="新建空库或上传独立 SQLite 快照；文件管理与数据库容器分开。"
        />
      ) : (
        <div className="@container">
          <ul
            aria-label="SQLite 文件列表"
            className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-4"
          >
            {files.map((file) => (
              <li key={file.id} className="h-full">
                <SqliteFileCard
                  file={file}
                  removing={removingIds.includes(file.id)}
                  onRemove={() => onRemove(file.id)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
