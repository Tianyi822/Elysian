import { useLogsStore } from '../../stores/logsStore'
import { LoginLogPanel } from './LoginLogPanel'
import { RuntimeLogPanel } from './RuntimeLogPanel'

/** 日志区页面：按顶栏页签渲染对应面板。 */
export function LogsPage() {
  const tab = useLogsStore((s) => s.tab)

  if (tab === 'login') {
    return <LoginLogPanel />
  }
  return <RuntimeLogPanel />
}
