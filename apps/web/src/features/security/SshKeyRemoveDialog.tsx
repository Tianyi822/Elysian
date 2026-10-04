import * as Dialog from '@radix-ui/react-dialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
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
    <Dialog.Root open onOpenChange={(open) => { if (!open) closeRemoveKey() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">
            确认删除 SSH 密钥「{removeKeyTarget.name}」？
          </Dialog.Title>
          <p className="mt-1.5 text-xs text-fg-muted">{description}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => closeRemoveKey()}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              取消
            </button>
            <button
              type="button"
              disabled={removingKeyIds.includes(removeKeyTarget.id)}
              onClick={() => {
                const keyId = removeKeyTarget.id
                closeRemoveKey()
                void removeKey(gateway, keyId)
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
