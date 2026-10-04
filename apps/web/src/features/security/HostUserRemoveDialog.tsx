import * as Dialog from '@radix-ui/react-dialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { useUsersStore } from '../../stores/usersStore'

/** 删除主机账号的确认弹窗：取消不删，确认后按运行时从演示数据集或系统账号移除。 */
export function HostUserRemoveDialog() {
  const gateway = useGateway()
  const removeTarget = useUsersStore((s) => s.removeTarget)
  const removingUserIds = useUsersStore((s) => s.removingUserIds)
  const closeRemove = useUsersStore((s) => s.closeRemove)
  const removeUser = useUsersStore((s) => s.removeUser)

  if (!removeTarget) return null

  // 说明按运行时如实：真实执行 userdel（不带 -r），主目录与它持有的文件保留在磁盘上；
  // 演示态声明只动演示数据集，不碰任何真实系统账号。
  const description = isDockerRuntime()
    ? '真实执行 userdel（不带 -r）：主目录与它持有的文件保留在磁盘上；主组一并移除，以它授权的 SSH 密钥随账号一起失效；以它身份运行的任务需要另行处理。'
    : '将从演示数据集中移除该账号：主组一并移除，以它授权的 SSH 密钥也会失效。这一步不会触碰任何真实系统账号。'

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) closeRemove() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">
            确认删除账号「{removeTarget.name}」？
          </Dialog.Title>
          <p className="mt-1.5 text-xs text-fg-muted">{description}</p>
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
