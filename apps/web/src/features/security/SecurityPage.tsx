import { useSecurityStore } from '../../stores/securityStore'
import { FirewallPanel } from './FirewallPanel'
import { SshPanel } from './SshPanel'

/** 安全区页面：按顶栏页签渲染对应面板。 */
export function SecurityPage() {
  const tab = useSecurityStore((s) => s.tab)

  if (tab === 'ssh') {
    return <SshPanel />
  }
  return <FirewallPanel />
}
