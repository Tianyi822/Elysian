import type { FirewallPortSync } from '@elysian/contracts'
import { useMessageStore } from './messageStore'

/*
 * 直连端口自动开放的结果通知：创建网站/数据库与切换为直连后按结果发声。
 * opened 单发一条成功提示（与创建成功通知并列）；failed 单发 danger 并指路安全页；
 * skipped（已有等价放行或防火墙片不可用）不打扰——无需用户动作。
 */
export function notifyFirewallPortSync(result: FirewallPortSync | null): void {
  if (result === null || result.state === 'skipped') return
  const notify = useMessageStore.getState().notify
  if (result.state === 'opened') {
    notify({ message: `防火墙端口 ${result.port} 已开放`, tone: 'success' })
    return
  }
  notify({
    message: `防火墙端口 ${result.port} 未能开放：${result.detail ?? '未知原因'}。项目已创建，请到安全页手动开放端口`,
    tone: 'danger',
  })
}
