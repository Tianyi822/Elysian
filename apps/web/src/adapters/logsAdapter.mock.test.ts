import { beforeEach, describe, expect, it } from 'vitest'
import { runLogsAdapterContract } from './logsAdapterContract'
import { MockLogsAdapter } from './mock/mockAdapters'
import {
  SEED_LOGIN_LOGS,
  SEED_OPERATION_LOGS,
  SEED_RUNTIME_LOGS,
  operationLogEntries,
  resetLogsData,
  runtimeLogEntries,
} from './mock/logsData'

/*
 * 契约集合对 mock 实现运行；每次经 make() 新建实例并恢复种子——
 * 清空会改写内存数组，共用状态会让用例互相影响。
 */
runLogsAdapterContract('mock', () => {
  resetLogsData()
  return new MockLogsAdapter()
})

describe('日志适配器 mock 数据形状', () => {
  beforeEach(() => {
    resetLogsData()
  })

  // 契约集合里的「两次读取相等」对同一引用的 mock 恒真，确定性由这里的种子断言锁住；
  // 登录记录非空与日志体积量级是演示数据属性，不进契约集合，留在 mock 侧断言。
  it('登录日志 mock：非空且读取结果与种子完全一致', async () => {
    const report = await new MockLogsAdapter().loginLogs()
    expect(report.entries.length).toBeGreaterThan(0)
    expect(report.entries).toEqual(SEED_LOGIN_LOGS)
    expect(report.truncated).toBe(false)
  })

  it('运行日志 mock：240 条确定性条目，与种子完全一致，跨多个等级且体积在十几 KB 量级', async () => {
    const report = await new MockLogsAdapter().runtimeLog()
    expect(report.entries).toEqual(SEED_RUNTIME_LOGS)
    expect(report.entries).toHaveLength(240)
    expect(new Set(report.entries.map((entry) => entry.level)).size).toBeGreaterThan(1)
    expect(report.truncated).toBe(false)
    // 不截断、无坏行：演示数据集不制造读取异常。
    expect(report.skippedLines).toBe(0)
    expect(report.skippedFiles).toBe(0)
    expect(report.storage.runtimeBytes).toBeGreaterThan(10 * 1024)
  })

  it('操作日志 mock：12 条确定性条目，覆盖四个分类与两种结果，不含数据库类条目', async () => {
    const report = await new MockLogsAdapter().operationLogs()
    expect(report.entries).toEqual(SEED_OPERATION_LOGS)
    expect(report.entries).toHaveLength(12)
    // 数据库分类的槽位在界面上保留、但演示数据里没有条目：演示动作不是审计事实（规格 10.5）。
    expect(new Set(report.entries.map((entry) => entry.category))).toEqual(
      new Set(['security', 'files', 'terminals', 'logs']),
    )
    expect(new Set(report.entries.map((entry) => entry.result))).toEqual(
      new Set(['success', 'failure']),
    )
  })

  it('清空只改内存并留下本次清空的留痕，resetLogsData 恢复种子', async () => {
    const adapter = new MockLogsAdapter()
    await adapter.clearLogs('runtime')

    expect(runtimeLogEntries()).toHaveLength(1)
    expect(runtimeLogEntries()[0]!.source).toBe('logs.clear')
    // 清空动作本身也进操作日志（与真实服务端的采集中间件同形）。
    expect(
      operationLogEntries().some((entry) => entry.category === 'logs' && entry.action.includes('清空')),
    ).toBe(true)

    resetLogsData()
    expect(runtimeLogEntries()).toEqual(SEED_RUNTIME_LOGS)
    expect(operationLogEntries()).toEqual(SEED_OPERATION_LOGS)
  })

  it('清空报告回已删除的事实：文件数与字节取清空前的该类别', async () => {
    const adapter = new MockLogsAdapter()
    const before = await adapter.runtimeLog()
    const report = await adapter.clearLogs('runtime')

    expect(report.category).toBe('runtime')
    expect(report.totalBytes).toBe(before.storage.runtimeBytes)
    expect(report.fileCount).toBeGreaterThan(0)
    // 条目倒序（最新在最上），最旧的那条因此在末位。
    expect(report.oldestAt).toBe(SEED_RUNTIME_LOGS[SEED_RUNTIME_LOGS.length - 1]!.at)
  })

  it('清空是幂等的：连清两次后该类别仍只剩一条留痕', async () => {
    const adapter = new MockLogsAdapter()
    await adapter.clearLogs('operation')
    await adapter.clearLogs('operation')
    const { entries } = await adapter.operationLogs()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.category).toBe('logs')
  })
})
