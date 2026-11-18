import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { useWebsitesStore } from '../../stores/websitesStore'

/**
 * 删除项目确认弹窗：删除是危险动作，确认文案明示会连站点目录一起删除；
 * 取消与关闭都不产生任何变更。
 */
export function WebsitesRemoveDialog() {
  const gateway = useGateway()
  const removeTarget = useWebsitesStore((s) => s.removeTarget)
  const busyProjectIds = useWebsitesStore((s) => s.busyProjectIds)
  const closeRemove = useWebsitesStore((s) => s.closeRemove)
  const removeProject = useWebsitesStore((s) => s.removeProject)

  if (!removeTarget) return null
  const removing = busyProjectIds.includes(removeTarget.id)
  const title = `确认删除项目「${removeTarget.name}」？`

  return (
    <ConfirmDialog
      title={title} titleClassName="sr-only"
      surface={{ layer: 'lower', preventOutsideDismiss: true, className: 'flex w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden shadow-2xl' }}
      footerClassName="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5"
      danger busy={removing} confirmLabel={removing ? '删除中…' : '确认删除'}
      onClose={closeRemove}
      onConfirm={() => void removeProject(gateway, removeTarget)}
    >
      <div className="flex flex-col gap-2 px-4 py-4">
        <p className="text-sm font-medium text-fg">{title}</p>
        <p className="text-xs text-fg-muted">
          将停止并删除站点容器、删除站点目录 {removeTarget.rootDir}（含其中全部文件）、移除登记并回收反向代理配置，不可恢复。
        </p>
      </div>
    </ConfirmDialog>
  )
}
