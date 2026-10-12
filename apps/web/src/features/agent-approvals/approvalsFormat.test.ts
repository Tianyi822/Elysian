import { describe, expect, it } from 'vitest'
import { AGENT_OPERATION_POLICY_LABELS, byteLength, formatApprovalCountdown } from './approvalsFormat'

/** 倒计时与字节计数：纯函数，全部注入时间断言，不依赖当前时钟。 */

describe('到期倒计时', () => {
  const NOW = new Date('2026-10-11T08:00:00Z').getTime()

  it('24 小时内按「小时 分」呈现；不足 1 小时只给分钟', () => {
    expect(formatApprovalCountdown('2026-10-12T07:59:00Z', NOW)).toEqual({ text: '23 小时 59 分', expired: false })
    expect(formatApprovalCountdown('2026-10-11T09:00:00Z', NOW)).toEqual({ text: '1 小时 0 分', expired: false })
    expect(formatApprovalCountdown('2026-10-11T08:40:00Z', NOW)).toEqual({ text: '40 分', expired: false })
    expect(formatApprovalCountdown('2026-10-11T08:00:30Z', NOW)).toEqual({ text: '不足 1 分钟', expired: false })
  })

  it('到期点及过去标记已过期；非法时间显示未知', () => {
    expect(formatApprovalCountdown('2026-10-11T08:00:00Z', NOW)).toEqual({ text: '已过期', expired: true })
    expect(formatApprovalCountdown('2026-10-10T00:00:00Z', NOW)).toEqual({ text: '已过期', expired: true })
    expect(formatApprovalCountdown('not-a-time', NOW)).toEqual({ text: '未知', expired: false })
  })
})

describe('策略标签与字节计数', () => {
  it('三种 policy 取值都有中文标签', () => {
    expect(AGENT_OPERATION_POLICY_LABELS['']).toBe('默认（逐调用审批）')
    expect(AGENT_OPERATION_POLICY_LABELS['approval-required']).toBe('需要审批')
    expect(AGENT_OPERATION_POLICY_LABELS['trusted-read-only']).toBe('受信只读')
  })

  it('字节计数按 UTF-8：中文每字 3 字节', () => {
    expect(byteLength('')).toBe(0)
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('证据')).toBe(6)
    expect(byteLength('长'.repeat(2730))).toBe(8190)
    expect(byteLength('长'.repeat(2731))).toBe(8193)
  })
})
