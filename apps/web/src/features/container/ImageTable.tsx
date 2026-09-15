import { Trash2 } from '../../components/icons'
import type { Container, ContainerImage } from '@elysian/contracts'
import { imageUsageCount } from '../../adapters/mock/containerViews'

const TH = 'px-4 py-3 font-medium'

/** 镜像视图：固定列宽表格，行内两行布局撑起可读高度；删除动作待接入真实执行，一律禁用并用 title 说明。 */
export function ImageTable({
  images,
  containers,
}: {
  images: readonly ContainerImage[]
  containers: readonly Container[]
}) {
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
          <tr className="border-b border-line text-left text-xs text-fg-muted">
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
            const title =
              usage > 0 ? `有 ${usage} 个容器使用中，且删除待接入` : '镜像删除待接入真实执行'
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
                <td className="px-4 py-3 tabular-nums text-fg-muted">{image.pulledAt.slice(0, 10)}</td>
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
                    disabled
                    title={title}
                    className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-fg-subtle disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Trash2 aria-hidden size={13} />
                    删除
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
