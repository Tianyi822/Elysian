import {
  LOGIN_LOG_STATUSES,
  OPERATION_LOG_CATEGORIES,
  OPERATION_LOG_OUTCOMES,
  PLATFORM_LOG_CATEGORIES,
  PLATFORM_LOG_LEVELS,
} from '@elysian/contracts'
import type { PlatformLogCategory } from '@elysian/contracts'
import { describe, expect, it } from 'vitest'
import type { LogsAdapter } from '../contracts/adapters'

/*
 * 日志适配器的可复用断言集合：只依赖 LogsAdapter 接口本身，不依赖任何 mock 细节
 * （对齐 containerAdapterContract 先例）。mock 实现与容器内的 HTTP 实现对同一套断言
 * 各跑一遍——这就是「mock 可替换」的验证方式。
 *
 * 两处口径是刻意的，不要改回更严的写法：
 * - 列表可以为空：真实服务端上目录可能刚被清空，断言「非空」会把演示数据的属性
 *   错当成实现契约（种子非空属于 mock 侧断言）。
 * - 清空之后**不是**空表：清空动作本身会留下一条留痕（规格 7.2 的自指留痕），
 *   因此断言的形状是「该类别最多剩一条，且若剩一条必须是本次清空的留痕」。
 *
 * 每次用例都经 make() 新建一份实现：清空会改写状态，共用实例会让用例互相影响。
 */
export function runLogsAdapterContract(name: string, make: () => LogsAdapter): void {
  describe(`LogsAdapter 契约（${name}）`, () => {
    it('登录日志：两次读取完全一致', async () => {
      const adapter = make()
      expect(await adapter.loginLogs()).toEqual(await adapter.loginLogs())
    })

    it('登录日志：按时间倒序，状态取值合法，字段齐全', async () => {
      const report = await make().loginLogs()
      expect(report.truncated).toEqual(expect.any(Boolean))
      expect(report.skippedLines).toBeGreaterThanOrEqual(0)
      expect(report.skippedFiles).toBeGreaterThanOrEqual(0)
      for (const entry of report.entries) {
        expect(LOGIN_LOG_STATUSES).toContain(entry.status)
        expect(entry.ip).toBeTruthy()
        expect(entry.location).toBeTruthy()
        expect(entry.userAgent).toBeTruthy()
        expect(entry.time).toBeTruthy()
      }
      const times = report.entries.map((entry) => entry.time)
      expect([...times].sort().reverse()).toEqual(times)
    })

    it('运行日志：两次读取完全一致', async () => {
      const adapter = make()
      expect(await adapter.runtimeLog()).toEqual(await adapter.runtimeLog())
    })

    it('运行日志：字段齐全、等级合法、时间可解析、按时间倒序、标识唯一', async () => {
      const report = await make().runtimeLog()
      for (const entry of report.entries) {
        expect(PLATFORM_LOG_LEVELS).toContain(entry.level)
        expect(entry.id).toBeTruthy()
        expect(entry.source).toBeTruthy()
        expect(entry.message).toBeTruthy()
        expect(Number.isNaN(Date.parse(entry.at))).toBe(false)
      }
      const times = report.entries.map((entry) => entry.at)
      expect([...times].sort().reverse()).toEqual(times)
      expect(new Set(report.entries.map((entry) => entry.id)).size).toBe(report.entries.length)
    })

    it('操作日志：两次读取完全一致、按时间倒序、分类与结果合法', async () => {
      const adapter = make()
      const report = await adapter.operationLogs()
      expect(await adapter.operationLogs()).toEqual(report)
      for (const entry of report.entries) {
        expect(OPERATION_LOG_CATEGORIES).toContain(entry.category)
        expect(OPERATION_LOG_OUTCOMES).toContain(entry.result)
        expect(entry.id).toBeTruthy()
        expect(entry.action).toBeTruthy()
        expect(Number.isNaN(Date.parse(entry.at))).toBe(false)
      }
      const times = report.entries.map((entry) => entry.at)
      expect([...times].sort().reverse()).toEqual(times)
      expect(new Set(report.entries.map((entry) => entry.id)).size).toBe(report.entries.length)
    })

    it('两类列表都带自洽的截断标记、坏行/坏文件计数与存储统计', async () => {
      const adapter = make()
      const runtime = await adapter.runtimeLog()
      const operation = await adapter.operationLogs()
      for (const report of [runtime, operation]) {
        expect(typeof report.truncated).toBe('boolean')
        expect(report.skippedLines).toBeGreaterThanOrEqual(0)
        expect(report.skippedFiles).toBeGreaterThanOrEqual(0)
      }
      for (const storage of [runtime.storage, operation.storage]) {
        expect(storage.totalBytes).toBe(storage.runtimeBytes + storage.operationBytes)
        expect(storage.runtimeBytes).toBeGreaterThanOrEqual(0)
        expect(storage.operationBytes).toBeGreaterThanOrEqual(0)
        expect(storage.fileCount).toBeGreaterThanOrEqual(0)
        expect(storage.droppedRecords).toBeGreaterThanOrEqual(0)
        expect(storage.failedWrites).toBeGreaterThanOrEqual(0)
        expect(typeof storage.trimmedBySize).toBe('boolean')
        for (const at of [storage.oldestAt, storage.lastSweepAt]) {
          if (at !== null) expect(Number.isNaN(Date.parse(at))).toBe(false)
        }
      }
    })

    it.each(PLATFORM_LOG_CATEGORIES)(
      '清空 %s：报告回已删除的事实，该类别最多剩一条且若剩一条必是本次清空的留痕',
      async (category: PlatformLogCategory) => {
        const adapter = make()
        const report = await adapter.clearLogs(category)
        expect(report.category).toBe(category)
        expect(report.fileCount).toBeGreaterThanOrEqual(0)
        expect(report.totalBytes).toBeGreaterThanOrEqual(0)
        expect(Number.isNaN(Date.parse(report.clearedAt))).toBe(false)
        if (report.oldestAt !== null) expect(Number.isNaN(Date.parse(report.oldestAt))).toBe(false)

        if (category === 'runtime') {
          const { entries } = await adapter.runtimeLog()
          expect(entries.length).toBeLessThanOrEqual(1)
          // 留痕的形状：来源是清空动作本身。
          if (entries.length === 1) expect(entries[0]!.source).toBe('logs.clear')
        } else {
          const { entries } = await adapter.operationLogs()
          expect(entries.length).toBeLessThanOrEqual(1)
          if (entries.length === 1) {
            expect(entries[0]!.category).toBe('logs')
            expect(entries[0]!.action).toContain('清空')
          }
        }
      },
    )
  })
}
