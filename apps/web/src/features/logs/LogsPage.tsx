import { useLogsStore } from '../../stores/logsStore'
import { LoginLogPanel } from './LoginLogPanel'
import { OperationLogPanel } from './OperationLogPanel'
import { RuntimeLogPanel } from './RuntimeLogPanel'

/** 日志区页面：按顶栏页签渲染对应面板（运行日志、登录日志、操作日志）。 */
export function LogsPage() {
  const tab = useLogsStore((s) => s.tab)

  if (tab === 'login') {
    return <LoginLogPanel />
  }
  if (tab === 'operation') {
    return <OperationLogPanel />
  }
  return <RuntimeLogPanel />
}
