import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../utils/isDockerRuntime'
import { useSshStore } from '../../stores/sshStore'

/** 删除 SSH 密钥的确认弹窗：取消不删，确认后按运行时从演示数据集或本机授权文件移除。 */
export function SshKeyRemoveDialog() {
  const gateway = useGateway()
  const removeKeyTarget = useSshStore((s) => s.removeKeyTarget)
  const removingKeyIds = useSshStore((s) => s.removingKeyIds)
  const closeRemoveKey = useSshStore((s) => s.closeRemoveKey)
  const removeKey = useSshStore((s) => s.removeKey)

  if (!removeKeyTarget) return null

  const description = isDockerRuntime()
    ? '删除后这份私钥作废，本机授权文件里它的公钥会一并移除，客户端不能再拿它免密登录。'
    : '删除后这份私钥作废，演示数据集里它的公钥会一并移除。这一步不会触碰任何真实授权文件。'

  return (
    <ConfirmDialog
      title={`确认删除 SSH 密钥「${removeKeyTarget.name}」？`}
      description={<p className="mt-1.5 text-xs text-fg-muted">{description}</p>}
      danger busy={removingKeyIds.includes(removeKeyTarget.id)} confirmLabel="确认删除"
      onClose={closeRemoveKey}
      onConfirm={() => {
        const keyId = removeKeyTarget.id
        closeRemoveKey()
        void removeKey(gateway, keyId)
      }}
    />
  )
}
