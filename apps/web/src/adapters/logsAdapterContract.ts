import { LOGIN_LOG_STATUSES } from '@elysian/contracts'
import { expect, it } from 'vitest'
import type { ElysianGateway } from '../contracts/adapters'

/**
 * 日志适配器的可复用断言集合：本期对 mock 实现运行，
 * 未来接入真实采集服务时对同一套断言再跑一次——这就是「mock 可替换」的验证方式。
 * 在测试文件的 describe 作用域里调用（内部注册 it）。
 */
export function runLogsAdapterContract(gateway: ElysianGateway) {
  it('登录日志：两次读取完全一致，演示数据确定性可复现', async () => {
    expect(await gateway.logs.loginLogs()).toEqual(await gateway.logs.loginLogs())
  })

  it('登录日志：按时间倒序，状态取值合法，字段齐全', async () => {
    const entries = await gateway.logs.loginLogs()
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(LOGIN_LOG_STATUSES).toContain(entry.status)
      expect(entry.ip).toBeTruthy()
      expect(entry.location).toBeTruthy()
      expect(entry.userAgent).toBeTruthy()
      expect(entry.time).toBeTruthy()
    }
    const times = entries.map((entry) => entry.time)
    expect([...times].sort().reverse()).toEqual(times)
  })

  it('运行日志：内容非空，字节数与 UTF-8 编码长度一致', async () => {
    const snapshot = await gateway.logs.runtimeLog()
    expect(snapshot.content.length).toBeGreaterThan(0)
    expect(snapshot.sizeBytes).toBe(new TextEncoder().encode(snapshot.content).length)
    expect(snapshot.sizeBytes).toBeGreaterThan(10 * 1024)
  })
}
