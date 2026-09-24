import * as Dialog from '@radix-ui/react-dialog'
import { Loader2, Trash2 } from '../../components/icons'
import { useState } from 'react'
import type { Container, ContainerImage } from '@elysian/contracts'
import { imageUsageCount } from '../../adapters/mock/containerViews'
import { useGateway } from '../../adapters/GatewayProvider'
import { useContainersStore } from '../../stores/containersStore'
import { registryHost } from './imageReference'

const TH = 'px-4 py-3 text-sm font-medium'

/**
 * 镜像视图：固定列宽表格，行内两行布局撑起可读高度。
 * 删除为演示动作：只允许删除未被引用的镜像，经确认对话框后落实到 mock 数据集。
 */
export function ImageTable({
  images,
  containers,
}: {
  images: readonly ContainerImage[]
  containers: readonly Container[]
}) {
  const gateway = useGateway()
  const removingImageIds = useContainersStore((s) => s.removingImageIds)
  const removeImage = useContainersStore((s) => s.removeImage)
  const pullingImage = useContainersStore((s) => s.pullingImage)
  const [pendingDelete, setPendingDelete] = useState<ContainerImage | null>(null)

  return (
    <section aria-label="镜像列表" className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full table-fixed text-sm" aria-label="镜像列表">
        <colgroup>
          <col className="w-[38%]" />
          <col className="w-[14%]" />
          <col className="w-[16%]" />
          <col className="w-[16%]" />
          <col className="w-[16%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-line text-left text-fg-muted">
            <th scope="col" className={TH}>名称:标签</th>
            <th scope="col" className={`${TH} text-right`}>大小</th>
            <th scope="col" className={TH}>拉取时间</th>
            <th scope="col" className={`${TH} text-right`}>引用数</th>
            <th scope="col" className={TH}>操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {images.map((image) => {
            const usage = imageUsageCount(containers, image.id)
            const removing = removingImageIds.includes(image.id)
            const deleteTitle =
              usage > 0
                ? `被 ${usage} 个容器引用，无法删除`
                : removing
                  ? '删除中…'
                  : `删除 ${image.name}:${image.tag}`
            return (
              <tr key={image.id} className="transition-colors hover:bg-surface-raised/60">
                <td className="px-4 py-3">
                  {/* 两行布局：名称:标签为主信息，摘要作次要行补足辨识度。 */}
                  <div className="truncate">
                    <span className="font-medium">{image.name}</span>
                    <span className="text-fg-muted">:{image.tag}</span>
                  </div>
                  <div
                    className="truncate font-mono text-xs text-fg-subtle"
                    title={image.digest}
                  >
                    {image.digest}
                  </div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{image.sizeMb} MB</td>
                <td className="px-4 py-3 tabular-nums text-fg-muted">
                  {image.pulledAt ? image.pulledAt.slice(0, 10) : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  {usage > 0 ? (
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-raised px-2 py-0.5 text-xs text-fg"
                      title={`${image.name}:${image.tag} 被 ${usage} 个容器引用`}
                    >
                      <span className="font-medium tabular-nums">{usage}</span>
                      <span className="text-fg-muted">个容器</span>
                    </span>
                  ) : (
                    <span className="text-xs text-fg-subtle">未使用</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <button
                    type="button"
                    disabled={usage > 0 || removing}
                    title={deleteTitle}
                    onClick={() => setPendingDelete(image)}
                    className={[
                      'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-colors',
                      usage > 0 || removing
                        ? 'border-line text-fg-subtle disabled:cursor-not-allowed disabled:opacity-60'
                        : 'border-line text-fg-muted hover:border-danger/50 hover:bg-danger/10 hover:text-danger',
                    ].join(' ')}
                  >
                    <Trash2 aria-hidden size={13} />
                    删除
                  </button>
                </td>
              </tr>
            )
          })}
          {pullingImage ? (
            <tr>
              <td colSpan={5} className="px-4 py-3">
                <div className="flex items-center gap-2 text-sm text-fg-muted">
                  <Loader2 aria-hidden size={14} className="shrink-0 animate-spin text-accent" />
                  <span className="shrink-0 font-mono text-fg">
                    {/* 完整拉取路径：源主机名 + 引用，与弹窗预览同一形状。 */}
                    {pullingImage.registry ? `${registryHost(pullingImage.registry)}/` : ''}
                    {pullingImage.name}:{pullingImage.tag}
                  </span>
                  <span className="shrink-0 text-xs">拉取中…</span>
                  {/* 不确定进度条：滑块来回扫，motion-reduce 下静止。 */}
                  <span
                    aria-hidden="true"
                    className="relative h-1 flex-1 overflow-hidden rounded-full bg-surface-raised"
                  >
                    <span className="pull-progress absolute inset-y-0 left-0 w-1/3 rounded-full bg-accent/60 motion-reduce:animate-none" />
                  </span>
                </div>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <Dialog.Root
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface-raised p-4 shadow-xl"
          >
            <Dialog.Title className="text-sm font-semibold">
              确认删除镜像「{pendingDelete?.name}:{pendingDelete?.tag}」？
            </Dialog.Title>
            <p className="mt-1.5 text-xs text-fg-muted">
              将从演示数据集中移除该镜像，正在运行的容器不受影响。这一步不会触碰任何真实环境。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  const image = pendingDelete
                  setPendingDelete(null)
                  if (image) void removeImage(gateway, image.id)
                }}
                className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/20"
              >
                确认删除
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  )
}
