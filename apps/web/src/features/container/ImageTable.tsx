import { Trash2 } from '../../components/icons'
import type { Container, ContainerImage } from '@elysian/contracts'
import { imageUsageCount } from '../../adapters/mock/containerViews'

/** 镜像视图：固定列宽表格，删除动作待接入真实执行，一律禁用并用 title 说明。 */
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
          <col className="w-2/5" />
          <col className="w-1/6" />
          <col className="w-1/6" />
          <col className="w-1/12" />
          <col className="w-1/12" />
        </colgroup>
        <thead>
          <tr className="border-b border-line text-left text-xs text-fg-muted">
            <th scope="col" className="px-4 py-2 font-medium">名称:标签</th>
            <th scope="col" className="px-4 py-2 font-medium">大小</th>
            <th scope="col" className="px-4 py-2 font-medium">拉取时间</th>
            <th scope="col" className="px-4 py-2 font-medium">引用数</th>
            <th scope="col" className="px-4 py-2 font-medium">删除</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {images.map((image) => {
            const usage = imageUsageCount(containers, image.id)
            const title =
              usage > 0 ? `有 ${usage} 个容器使用中，且删除待接入` : '镜像删除待接入真实执行'
            return (
              <tr key={image.id}>
                <td className="truncate px-4 py-2">
                  <span className="font-medium">{image.name}</span>
                  <span className="text-fg-muted">:{image.tag}</span>
                </td>
                <td className="tabular-nums px-4 py-2">{image.sizeMb} MB</td>
                <td className="px-4 py-2 text-fg-muted">{image.pulledAt.slice(0, 10)}</td>
                <td className="tabular-nums px-4 py-2">{usage}</td>
                <td className="px-4 py-2">
                  <button
                    type="button"
                    disabled
                    title={title}
                    className="inline-flex items-center gap-1 text-xs text-fg-subtle disabled:cursor-not-allowed"
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
