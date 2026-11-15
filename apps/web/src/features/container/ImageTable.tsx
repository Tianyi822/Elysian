import * as Dialog from '@radix-ui/react-dialog'
import { Loader2, Trash2 } from '../../components/icons'
import { useState } from 'react'
import type { Container, ContainerImage } from '@elysian/contracts'
import { imageUsageCount } from '../../adapters/mock/containerViews'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { useContainersStore } from '../../stores/containersStore'
import { ImageReferenceLabel } from './ImageReferenceLabel'
import { DataTable, type Id } from '../../components/DataTable'
import { TableBatchActions } from '../../components/TableBatchActions'
import { Button } from '../../components/Button'

const PULL_PHASE_TEXT = {
  preparing: '正在准备镜像层',
  downloading: '下载镜像层',
  extracting: '解压镜像层',
  finalizing: '正在校验并写入镜像',
}

function formatPullBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

/**
 * 镜像视图：固定列宽表格，行内两行布局撑起可读高度。
 * 删除镜像只允许未被引用的镜像，经确认对话框后交给当前运行时（Docker 或演示数据集）。
 */
export function ImageTable({
  images,
  containers,
  busy = false,
}: {
  images: readonly ContainerImage[]
  containers: readonly Container[]
  /** 刷新在途：保留旧镜像行，仅标记可访问的忙碌状态。 */
  busy?: boolean
}) {
  const gateway = useGateway()
  const removingImageIds = useContainersStore((s) => s.removingImageIds)
  const removeImage = useContainersStore((s) => s.removeImage)
  const pullingImage = useContainersStore((s) => s.pullingImage)
  const cancelImagePull = useContainersStore((s) => s.cancelImagePull)
  const imagePullError = useContainersStore((s) => s.imagePullError)
  const dismissImagePullError = useContainersStore((s) => s.dismissImagePullError)
  const [selected, setSelected] = useState<Id[]>([])
  const [pendingDelete, setPendingDelete] = useState<ContainerImage | null>(null)

  const docker = isDockerRuntime()

  return (
    <div className="relative rounded-xl min-w-0" aria-busy={busy}>
      <section>
        <DataTable rows={images} ariaLabel="镜像列表" selected={selected} onSelectionChange={setSelected} busy={busy}
          getRowLabel={image => `${image.name}:${image.tag}`}
          searchPlaceholder="搜索镜像"
          columns={[
            { key: 'name', header: '名称:标签', primary: true, width: 'minmax(240px,2fr)', accessor: image => `${image.name}:${image.tag}`, cell: image => <>
              <div className="truncate"><ImageReferenceLabel name={image.name} tag={image.tag} />{image.otherTags?.length ? <span className="ml-2 text-xs text-fg-muted" title={image.otherTags.join('、')}>另有 {image.otherTags.length} 个标签</span> : null}</div>
              <div className="truncate font-mono text-xs text-fg-subtle" title={image.digest}>{image.digest}</div>
            </> },
            { key: 'sizeMb', header: '大小', align: 'right', width: '110px', accessor: image => image.sizeMb, cell: image => <span className="tabular-nums">{image.sizeMb} MB</span> },
            { key: 'pulledAt', header: '拉取时间', width: '130px', accessor: image => image.pulledAt ? new Date(image.pulledAt) : null, cell: image => <span className="tabular-nums text-fg-muted">{image.pulledAt ? image.pulledAt.slice(0, 10) : '—'}</span> },
            { key: 'usage', header: '引用数', align: 'right', width: '120px', accessor: image => imageUsageCount(containers, image.id), cell: image => imageUsageCount(containers, image.id) > 0 ? <span className="inline-flex items-center gap-1 rounded-full border border-control-line bg-surface-raised px-2 py-0.5 text-xs text-fg" title={`${image.name}:${image.tag} 被 ${imageUsageCount(containers, image.id)} 个容器引用`}><span className="font-medium tabular-nums">{imageUsageCount(containers, image.id)}</span><span className="text-fg-muted">个容器</span></span> : <span className="text-xs text-fg-subtle">未使用</span> },
            { key: 'actions', header: '操作', sortable: false, width: '110px', cell: image => {
              const usage = imageUsageCount(containers, image.id), removing = removingImageIds.includes(image.id)
              return <Button variant="destructive" type="button" disabled={usage > 0 || removing} title={usage > 0 ? `被 ${usage} 个容器引用，无法删除` : removing ? '删除中…' : `删除 ${image.name}:${image.tag}`} onClick={() => setPendingDelete(image)} className="gap-1 px-2 text-xs"><Trash2 aria-hidden size={13} />删除</Button>
            } },
          ]}
          bulkActions={ids => <TableBatchActions selectedRows={images.filter(image => ids.includes(image.id))} getRowId={image => image.id}
            getRowLabel={image => [`${image.name}:${image.tag}`, ...(image.otherTags ?? [])].join('、')}
            onSucceeded={done => setSelected(current => current.filter(id => !done.includes(id)))} disabled={removingImageIds.length > 0}
            actions={[{ key: 'remove', label: '删除', danger: true, description: '将删除所选镜像及其列出的全部标签。被容器引用的镜像会跳过。',
              eligible: image => imageUsageCount(containers, image.id) > 0 ? '镜像仍被容器引用' : removingImageIds.includes(image.id) ? '正在删除' : undefined,
              execute: async group => {
                const image = group[0]!
                if (imageUsageCount(useContainersStore.getState().containers, image.id) > 0) return { status: 'failed', error: '镜像仍被容器引用' }
                return removeImage(gateway, image.id)
              },
            }]} />}
        />
        {imagePullError ? (
          <div className="border-t border-line px-4 py-3">
            <div role="alert" className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-danger">拉取镜像失败</p>
                <div className="mt-1 font-mono text-xs text-fg-muted">
                  <ImageReferenceLabel {...imagePullError} />
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-xs text-danger">{imagePullError.message}</p>
              </div>
              <Button variant="outline" type="button" onClick={dismissImagePullError} aria-label="关闭拉取错误"
                className="shrink-0 rounded-lg border border-control-line px-2.5 py-1 text-xs text-fg-muted transition-colors hover:text-fg">
                关闭
              </Button>
            </div>
          </div>
        ) : null}
        {pullingImage ? (
          <div className="border-t border-line px-4 py-3" aria-label="镜像拉取状态">
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <Loader2 aria-hidden size={14} className="shrink-0 animate-spin text-accent-fg" />
              <div className="min-w-0 flex-1 font-mono text-fg"><ImageReferenceLabel {...pullingImage} /></div>
              <Button variant="destructive"
                type="button"
                onClick={cancelImagePull}
                disabled={pullingImage.cancelling}
                className="min-h-11 shrink-0 rounded-lg border border-control-line px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-danger hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pullingImage.cancelling ? '正在停止…' : '停止拉取'}
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
              <span className="basis-full break-words" aria-live="polite">
                {pullingImage.cancelling ? '正在停止拉取' : pullingImage.progress?.message ?? (
                  pullingImage.progress ? PULL_PHASE_TEXT[pullingImage.progress.phase] : '正在连接镜像拉取服务'
                )}
                {pullingImage.progress?.layerId && pullingImage.progress.phase !== 'finalizing'
                  ? ` ${pullingImage.progress.layerId.slice(0, 12)}` : ''}
              </span>
              {pullingImage.progress?.totalBytes ? (
                <span className="shrink-0 tabular-nums">
                  {formatPullBytes(pullingImage.progress.currentBytes ?? 0)} / {formatPullBytes(pullingImage.progress.totalBytes)}
                </span>
              ) : null}
              {pullingImage.progress?.totalBytes ? (
                <span className="shrink-0 font-medium tabular-nums text-fg">
                  {Math.floor((pullingImage.progress.currentBytes ?? 0) / pullingImage.progress.totalBytes * 100)}%
                </span>
              ) : null}
            </div>
            <div
              role="progressbar"
              aria-label="镜像层拉取进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pullingImage.progress?.totalBytes
                ? Math.floor((pullingImage.progress.currentBytes ?? 0) / pullingImage.progress.totalBytes * 100)
                : undefined}
              className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-surface-raised"
            >
              {pullingImage.progress?.totalBytes ? (
                <span className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-150 motion-reduce:transition-none"
                  style={{ width: `${(pullingImage.progress.currentBytes ?? 0) / pullingImage.progress.totalBytes * 100}%` }} />
              ) : (
                <span className="pull-progress absolute inset-y-0 left-0 w-1/3 rounded-full bg-accent/60 motion-reduce:animate-none" />
              )}
            </div>
          </div>
        ) : null}

        <Dialog.Root
          open={pendingDelete !== null}
          onOpenChange={(open) => {
            if (!open) setPendingDelete(null)
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl"
            >
              <Dialog.Title className="text-sm font-semibold">
                确认删除镜像「{pendingDelete?.name}:{pendingDelete?.tag}」？
              </Dialog.Title>
              {docker ? (
                <>
                  <p className="mt-1.5 text-xs text-fg-muted">
                    将移除该镜像的全部标签。正在使用它的容器会阻止删除。
                  </p>
                  {pendingDelete ? (
                    <ul className="mt-2 space-y-0.5 font-mono text-xs text-fg-muted">
                      <li>{`${pendingDelete.name}:${pendingDelete.tag}`}</li>
                      {pendingDelete.otherTags?.map((tag) => (
                        <li key={tag}>{tag}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <p className="mt-1.5 text-xs text-fg-muted">
                  将从演示数据集中移除该镜像，正在运行的容器不受影响。这一步不会触碰任何真实环境。
                </p>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="outline"
                  type="button"
                  onClick={() => setPendingDelete(null)}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
                >
                  取消
                </Button>
                <Button variant="destructive"
                  type="button"
                  onClick={() => {
                    const image = pendingDelete
                    setPendingDelete(null)
                    if (image) void removeImage(gateway, image.id)
                  }}
                  className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/20"
                >
                  确认删除
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </section>
    </div>
  )
}
