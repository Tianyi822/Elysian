import { LOGIN_LOG_STATUSES } from '@elysian/contracts'
import { describe, expect, it } from 'vitest'
import type { LogsAdapter } from '../contracts/adapters'

/**
 * 日志适配器的可复用断言集合：只依赖 LogsAdapter 接口本身（对齐 containerAdapterContract 先例），
 * 本期对 mock 实现运行，未来接入真实采集服务时对同一套断言再跑一次——这就是「mock 可替换」的验证方式。
 * 演示数据形状（登录记录非空、运行日志体积量级）属于 mock 数据集属性，其断言放在 mock 测试侧。
 * 自带 describe 包裹，在测试文件顶层调用。
 */
export function runLogsAdapterContract(adapter: LogsAdapter): void {
  describe('LogsAdapter 契约', () => {
    it('登录日志：两次读取完全一致', async () => {
      expect(await adapter.loginLogs()).toEqual(await adapter.loginLogs())
    })

    it('登录日志：按时间倒序，状态取值合法，字段齐全', async () => {
      const entries = await adapter.loginLogs()
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
      const snapshot = await adapter.runtimeLog()
      expect(snapshot.content.length).toBeGreaterThan(0)
      expect(snapshot.sizeBytes).toBe(new TextEncoder().encode(snapshot.content).length)
    })
  })
}
