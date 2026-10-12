import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentWorkbenchMockError,
  WORKSPACE_PREVIEW_LIMIT_BYTES,
  compareDecimalStrings,
  demoDigest,
  nextDecimalString,
  resetAgentWorkbenchData,
  workbenchInternals,
} from './agentWorkbenchData'

/*
 * 工作台演示状态机的单元口径：十进制字符串游标、Run 时间推进、取消语义
 * （排队/等待审批立即终止；执行中只登记请求，宽限后才 cancelled）、
 * 4 MiB 预览上限、种子隔离标记。时间断言全部用注入的 fake timers。
 */

const BASE = new Date('2026-10-10T08:00:00Z').getTime()

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE)
  resetAgentWorkbenchData(new Date(BASE))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('十进制字符串工具', () => {
  it('nextDecimalString 逐位进位，不经 number', () => {
    expect(nextDecimalString('0')).toBe('1')
    expect(nextDecimalString('9')).toBe('10')
    expect(nextDecimalString('99')).toBe('100')
    expect(nextDecimalString('9007199254740993')).toBe('9007199254740994')
  })

  it('compareDecimalStrings 先长后字典序', () => {
    expect(compareDecimalStrings('9', '10')).toBeLessThan(0)
    expect(compareDecimalStrings('9007199254740993', '9007199254740992')).toBeGreaterThan(0)
    expect(compareDecimalStrings('42', '42')).toBe(0)
  })

  it('demoDigest 确定性且形如十六进制摘要', () => {
    expect(demoDigest('a')).toBe(demoDigest('a'))
    expect(demoDigest('a')).not.toBe(demoDigest('b'))
    expect(demoDigest('workspace:task-1:1')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('种子会话', () => {
  it('session-1 空闲带两个已完成任务；session-2 busy 处于等待审批', () => {
    const first = workbenchInternals.getSession('session-1')
    expect(first.activeRunId).toBeUndefined()
    const tasks = workbenchInternals.listTasksPage('session-1')
    expect(tasks.items.length).toBe(2)
    expect(tasks.items[0]?.latestRun?.status).toBe('succeeded')
    const second = workbenchInternals.getSession('session-2')
    expect(second.activeRunId).toBe('run-3')
    const busyTask = workbenchInternals.getTask('task-3')
    expect(busyTask.latestRun?.status).toBe('waiting-approval')
  })

  it('种子包含 quarantined 消息与被隔离的工作区版本', () => {
    const messages = workbenchInternals.listMessagesPage('session-1')
    const quarantined = messages.items.find((message) => message.quarantined === true)
    expect(quarantined?.id).toBe('msg-4')
    const cited = messages.items.find((message) => message.wikiSources !== undefined && message.wikiSources.length > 0)
    expect(cited?.wikiSources?.[0]?.pageId).toBe('wiki-page-1')
    expect(workbenchInternals.listWorkspace('task-2').quarantined).toBe(true)
    expect(workbenchInternals.listWorkspace('task-1').quarantined).toBeUndefined()
  })
})

describe('Run 时间推进', () => {
  it('排队 1.5 秒后执行，6 秒后成功；答复消息随后可见', async () => {
    const run = workbenchInternals.createTask('session-1', { requestId: 'unit-run-1', content: '推进检查' })
    expect(workbenchInternals.getTask(run.taskId).latestRun?.status).toBe('queued')
    await tick(1600)
    const running = workbenchInternals.getTask(run.taskId).latestRun
    expect(running?.status).toBe('running')
    expect(running?.phase).toBe('inference')
    await tick(3000)
    expect(workbenchInternals.getTask(run.taskId).latestRun?.phase).toBe('final-memory')
    await tick(2000)
    const done = workbenchInternals.getTask(run.taskId).latestRun
    expect(done?.status).toBe('succeeded')
    expect(done?.endReason).toBe('completed')
    const session = workbenchInternals.getSession('session-1')
    expect(session.activeRunId).toBeUndefined()
    const messages = workbenchInternals.listMessagesPage('session-1')
    expect(messages.items.some((message) => message.runId === run.id && message.role === 'assistant')).toBe(true)
  })

  it('记忆状态：运行中 stale，成功后 updated', async () => {
    const run = workbenchInternals.createTask('session-1', { requestId: 'unit-run-2', content: '记忆状态' })
    expect(workbenchInternals.getTask(run.taskId).memoryStatus).toBe('stale')
    await tick(6500)
    expect(workbenchInternals.getTask(run.taskId).memoryStatus).toBe('updated')
    const memory = workbenchInternals.getWorkingMemory(run.taskId)
    expect(memory.memoryStatus).toBe('updated')
    expect(memory.facts[0]?.sources[0]?.runId).toBe(run.id)
    void run
  })
})

describe('取消语义', () => {
  it('排队中的 Run 取消立即变 cancelled', async () => {
    const run = workbenchInternals.createTask('session-1', { requestId: 'unit-cancel-1', content: '排队即取消' })
    const cancelled = workbenchInternals.requestCancel(run.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancelRequestedAt).toBeDefined()
    expect(workbenchInternals.getSession('session-1').activeRunId).toBeUndefined()
  })

  it('等待审批的 Run 取消立即终止；执行中的 Run 只登记请求并在宽限后停止', async () => {
    const waiting = workbenchInternals.requestCancel('run-3')
    expect(waiting.status).toBe('cancelled')

    const run = workbenchInternals.createTask('session-1', { requestId: 'unit-cancel-2', content: '执行中取消' })
    await tick(2000)
    const requested = workbenchInternals.requestCancel(run.id)
    // 「取消请求已提交」≠「已停止」：仍为 running，仅带 cancelRequestedAt。
    expect(requested.status).toBe('running')
    expect(requested.cancelRequestedAt).toBeDefined()
    await tick(1000)
    expect(workbenchInternals.getTask(run.taskId).latestRun?.status).toBe('running')
    await tick(1500)
    expect(workbenchInternals.getTask(run.taskId).latestRun?.status).toBe('cancelled')
  })

  it('终态 Run 重复取消回中文错误', () => {
    expect(() => workbenchInternals.requestCancel('run-1')).toThrow('运行已结束')
  })
})

describe('工作区', () => {
  it('超过 4 MiB 的文件预览回中文错误', async () => {
    const run = workbenchInternals.createTask('session-1', { requestId: 'unit-ws-1', content: '大文件' })
    await tick(6500)
    const big = new Uint8Array(WORKSPACE_PREVIEW_LIMIT_BYTES + 1)
    workbenchInternals.writeWorkspaceFile(run.taskId, 'big.bin', 0, big)
    try {
      workbenchInternals.readWorkspaceFile(run.taskId, 'big.bin')
      throw new Error('预期抛错，但读取成功了')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentWorkbenchMockError)
      expect((error as AgentWorkbenchMockError).message).toContain('4 MiB')
    }
  })

  it('删除不存在的文件回中文错误；写入路径为空拒绝', async () => {
    const run = workbenchInternals.createTask('session-1', { requestId: 'unit-ws-2', content: '边界' })
    await tick(6500)
    expect(() => workbenchInternals.deleteWorkspaceFile(run.taskId, 'none.txt', 0)).toThrow('不存在文件')
    expect(() => workbenchInternals.writeWorkspaceFile(run.taskId, '', 0, new Uint8Array(1))).toThrow('文件路径')
  })
})

describe('输入校验', () => {
  it('空内容与超限输入回中文错误', () => {
    expect(() => workbenchInternals.createTask('session-1', { requestId: 'unit-in-1', content: '  ' })).toThrow('输入内容不能为空')
    expect(() => workbenchInternals.createTask('session-1', { requestId: 'unit-in-2', content: 'x'.repeat(32 * 1024 + 1) })).toThrow('32 KiB')
  })

  it('超过 32 KiB 的多字节输入按字节数拒绝', () => {
    // 3 字节/字符：11000 个字符即 33000 字节。
    expect(() => workbenchInternals.createTask('session-1', { requestId: 'unit-in-3', content: '中'.repeat(11000) })).toThrow('32 KiB')
  })
})
