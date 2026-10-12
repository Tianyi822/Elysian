/*
 * 审批与治理页的纯展示工具：到期倒计时、策略标签与字节计数。
 * 时间断言全部走注入的 now，不依赖当前时钟；倒计时只做呈现，
 * 「已过期」的权威判定仍是服务端在下次列表读取时回传的 expired 状态。
 */

/** Operation policy 的中文标签（取值见 capability_types.go:97）。 */
export const AGENT_OPERATION_POLICY_LABELS: Record<string, string> = {
  '': '默认（逐调用审批）',
  'approval-required': '需要审批',
  'trusted-read-only': '受信只读',
}

/** 核实决定的中文标签（confirmed-completed / confirmed-stopped）。 */
export const AGENT_RECONCILIATION_DECISION_LABELS: Record<string, string> = {
  'confirmed-completed': '确认已完成',
  'confirmed-stopped': '确认已停止',
}

/** 到期倒计时：超过 1 小时给「N 小时 M 分」，不足 1 小时给「M 分」；已过期单独标记。 */
export function formatApprovalCountdown(expiresAt: string, now: number): { text: string; expired: boolean } {
  const target = new Date(expiresAt).getTime()
  if (Number.isNaN(target)) return { text: '未知', expired: false }
  const remaining = target - now
  if (remaining <= 0) return { text: '已过期', expired: true }
  const totalMinutes = Math.floor(remaining / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalMinutes < 1) return { text: '不足 1 分钟', expired: false }
  if (hours >= 1) return { text: `${hours} 小时 ${minutes} 分`, expired: false }
  return { text: `${minutes} 分`, expired: false }
}

/** 表单证据/原因的实时字节计数（服务端按字节上限校验，中文字符占 3 字节）。 */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}
