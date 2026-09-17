import { useLogsStore } from '../../stores/logsStore'
import { LoginLogPanel } from './LoginLogPanel'

/** 日志区页面：按顶栏页签渲染对应面板；运行日志面板在下一个任务接入。 */
export function LogsPage() {
  const tab = useLogsStore((s) => s.tab)

  if (tab === 'login') {
    return <LoginLogPanel />
  }
  return <div />
}
