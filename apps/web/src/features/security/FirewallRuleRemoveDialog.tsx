import * as Dialog from '@radix-ui/react-dialog'
import { formatFirewallPort } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { useFirewallStore } from '../../stores/firewallStore'

/** 删除端口规则的确认弹窗：取消不删，确认后按运行时从演示数据集或系统防火墙移除。 */
export function FirewallRuleRemoveDialog() {
  const gateway = useGateway()
  const removeTarget = useFirewallStore((s) => s.removeTarget)
  const removingRuleIds = useFirewallStore((s) => s.removingRuleIds)
  const closeRemove = useFirewallStore((s) => s.closeRemove)
  const removeRule = useFirewallStore((s) => s.removeRule)

  if (!removeTarget) return null
  const label = `${removeTarget.protocol} ${formatFirewallPort(removeTarget)}`
  const description = isDockerRuntime()
    ? '将从系统防火墙中删除这条规则（真实执行 ufw delete）。'
    : '将从演示数据集中移除这条规则。这一步不会触碰任何真实防火墙。'

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) closeRemove() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface-raised p-4 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">确认删除端口规则「{label}」？</Dialog.Title>
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
              disabled={removingRuleIds.includes(removeTarget.id)}
              onClick={() => {
                const ruleId = removeTarget.id
                closeRemove()
                void removeRule(gateway, ruleId)
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
