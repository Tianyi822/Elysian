import * as Dialog from '@radix-ui/react-dialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { useUsersStore } from '../../stores/usersStore'

/** 删除主机账号的确认弹窗：取消不删，确认后从演示数据集移除并留 mock 标注。 */
export function HostUserRemoveDialog() {
  const gateway = useGateway()
  const removeTarget = useUsersStore((s) => s.removeTarget)
  const removingUserIds = useUsersStore((s) => s.removingUserIds)
  const closeRemove = useUsersStore((s) => s.closeRemove)
  const removeUser = useUsersStore((s) => s.removeUser)

  if (!removeTarget) return null

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) closeRemove() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface-raised p-4 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">
            确认删除账号「{removeTarget.name}」？
          </Dialog.Title>
          <p className="mt-1.5 text-xs text-fg-muted">
            删除后这个账号的主组一并移除，以它身份运行的任务与它持有的文件需要另行处理，已经用它的密钥也登不进来。
            这一步不会触碰任何真实系统账号。
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => closeRemove()}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              取消
            </button>
            <button
              type="button"
              disabled={removingUserIds.includes(removeTarget.id)}
              onClick={() => {
                const userId = removeTarget.id
                closeRemove()
                void removeUser(gateway, userId)
              }}
              className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-50"
            >
              确认删除
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
