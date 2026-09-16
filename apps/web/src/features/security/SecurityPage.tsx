import { EmptyState } from '../../components/states/StateViews'
import { useSecurityStore } from '../../stores/securityStore'
import { FirewallPanel } from './FirewallPanel'

/** 安全区页面：按顶栏页签渲染对应面板；SSH 管理内容待实现。 */
export function SecurityPage() {
  const tab = useSecurityStore((s) => s.tab)

  if (tab === 'ssh') {
    return <EmptyState title="SSH 管理" description="本页签内容待实现。" />
  }
  return <FirewallPanel />
}
