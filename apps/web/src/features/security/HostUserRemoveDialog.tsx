import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../utils/isDockerRuntime'
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
    <ConfirmDialog
      title={`确认删除账号「${removeTarget.name}」？`}
      description={<p className="mt-1.5 text-xs text-fg-muted">{description}</p>}
      danger busy={removingUserIds.includes(removeTarget.id)} confirmLabel="确认删除"
      onClose={closeRemove}
      onConfirm={() => {
        const userId = removeTarget.id
        closeRemove()
        void removeUser(gateway, userId)
      }}
    />
  )
}
