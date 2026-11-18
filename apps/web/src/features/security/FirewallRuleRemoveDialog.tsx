import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { useFirewallStore } from '../../stores/firewallStore'

/** 删除规则的确认弹窗：取消不删，确认后按运行时从演示数据集或系统防火墙移除（端口/IP/转发三类共用）。 */
export function FirewallRuleRemoveDialog() {
  const gateway = useGateway()
  const removeTarget = useFirewallStore((s) => s.removeTarget)
  const removingRuleIds = useFirewallStore((s) => s.removingRuleIds)
  const closeRemove = useFirewallStore((s) => s.closeRemove)
  const removeRule = useFirewallStore((s) => s.removeRule)

  if (!removeTarget) return null
  const kindLabel = removeTarget.kind === 'port' ? '端口规则' : removeTarget.kind === 'ip' ? 'IP 规则' : '端口转发'

  return (
    <ConfirmDialog
      title={`确认删除${kindLabel}「${removeTarget.label}」？`}
      danger busy={removingRuleIds.includes(removeTarget.id)} confirmLabel="确认删除"
      onClose={closeRemove}
      onConfirm={() => {
        const { kind, id } = removeTarget
        closeRemove()
        void removeRule(gateway, kind, id)
      }}
    />
  )
}
