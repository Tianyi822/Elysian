import * as Dialog from '@radix-ui/react-dialog'
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

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeRemove() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[55] flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl"
        >
          <Dialog.Title className="sr-only">确认删除项目「{removeTarget.name}」？</Dialog.Title>
          <div className="flex flex-col gap-2 px-4 py-4">
            <p className="text-sm font-medium text-fg">
              确认删除项目「{removeTarget.name}」？
            </p>
            <p className="text-xs text-fg-muted">
              将停止并删除站点容器、删除站点目录 {removeTarget.rootDir}（含其中全部文件）、移除登记并回收反向代理配置，不可恢复。
            </p>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5">
            <button
              type="button"
              onClick={() => closeRemove()}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              取消
            </button>
            <button
              type="button"
              disabled={removing}
              onClick={() => void removeProject(gateway, removeTarget)}
              className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-50"
            >
              {removing ? '删除中…' : '确认删除'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
