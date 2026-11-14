import { describe, expect, it } from 'vitest'
import { parseRecovery, parseRecoveryFailure, parseRunReport, parseAttempts } from './agentRecoveryParse'

describe('恢复证据契约', () => {
  it('保留明确未执行证据和修正建议，拒绝未知的证据枚举', () => {
    const value = { code: 'missing-database', message: '缺少初始库名', evidence: { execution: 'not-started', changes: 'none', recovery: 'correct', suggestion: '补充 MYSQL_DATABASE' } }
    expect(parseRecoveryFailure(value)?.evidence?.suggestion).toBe('补充 MYSQL_DATABASE')
    expect(parseRecoveryFailure({ code: 'old', message: '旧回执' })).toEqual({ code: 'old', message: '旧回执' })
    expect(() => parseRecoveryFailure({ ...value, evidence: { execution: 'assumed-failed' } })).toThrow()
  })
  it('核实与失败报告保留独立事实，不从提示文字推断结果', () => {
    const recovery = { operationId: 'op', tool: 'docker_container_create_service', startedAt: 'start', deadline: 'deadline', checks: 2, status: 'unresolved', message: '无法取得可信回执' }
    expect(parseRecovery(recovery)).toEqual(recovery)
    expect(() => parseRecovery({ ...recovery, status: 'assumed-completed' })).toThrow()
    const report = { outcome: '未全部完成', reason: '缺少库名', completed: 1, failed: 1, unconfirmed: 0, steps: [{ callId: 'call', tool: 'docker_container_create_service', status: 'failed', attempts: 2 }], remaining: ['部署 MySQL'], next: '补齐参数后继续' }
    expect(parseRunReport(report)).toEqual(report)
    expect(parseAttempts([{ number: 1, error: { code: 'temporary', message: '暂不可用' } }])).toHaveLength(1)
    expect(() => parseAttempts([{ number: 4 }])).toThrow()
  })
})
