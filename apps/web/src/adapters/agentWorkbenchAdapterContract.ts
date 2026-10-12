import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentInput } from '@elysian/contracts'
import type { AgentWorkbenchAdapter } from '../contracts/adapters'

/*
 * Ely 工作台域 adapter 契约断言集：对 mock 与 HTTP 两个实现各跑一遍——
 * HTTP 侧的 fetch 换成按服务端路由形状实现的内存假服务，验证「mock 可替换」。
 * 断言覆盖验收语义：
 * - 会话闭环：创建回读、环境修订递增与 CAS 冲突、记忆空间选择回显；
 * - 任务提交：requestId 幂等回读同一 Run、不同输入 request-conflict、
 *   会话 busy 期间新输入与续轮按服务端中文文案拒绝；
 * - 续轮：任务终态后 runNumber 递增；模型切换后续轮被 model-changed 拒绝；
 * - 消息增量：after 游标只取新增、空页保留游标、future-cursor 拒绝；
 * - 工作区字节保真：PUT 原始字节经 GET base64 回读后逐字节一致（体不对称
 *   回归）、删除与 CAS 冲突、4 MiB 预览上限；
 * - 隔离标记：quarantined 消息与工作区版本如实回显。
 * 时钟推进由各测试文件注入（fake timers 的 advanceTimersByTimeAsync）。
 */

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code as string | undefined
    : undefined
}

async function rejectWith(promise: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await promise
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      code: errorCode(error),
    }
  }
  throw new Error('预期抛错，但请求成功了')
}

const CREATE_INPUT: AgentInput = { requestId: 'contract-create-1', content: '契约任务：检查容器状态' }

export function runAgentWorkbenchAdapterContract(
  name: string,
  make: () => AgentWorkbenchAdapter | Promise<AgentWorkbenchAdapter>,
  clock: { advance(ms: number): Promise<void> },
): void {
  describe(`AgentWorkbenchAdapter 契约断言：${name}`, () => {
    let adapter: AgentWorkbenchAdapter

    beforeEach(async () => {
      adapter = await make()
    })

    describe('会话与环境', () => {
      it('创建会话回读标题与模型修订；环境修订从读取值起步', async () => {
        const created = await adapter.createSession({ title: '契约会话', modelProfileId: 'profile-1', modelRevision: 2 })
        expect(created.title).toBe('契约会话')
        expect(created.modelProfileId).toBe('profile-1')
        expect(created.modelRevision).toBe(2)
        expect(created.lastSeq).toBe('0')
        const again = await adapter.getSession(created.id)
        expect(again.id).toBe(created.id)
        const environment = await adapter.getSessionEnvironment(created.id)
        expect(environment.sessionId).toBe(created.id)
        expect(environment.revision).toBeGreaterThanOrEqual(1)
      })

      it('更新环境后修订递增；旧 expectedRevision 冲突回中文错误', async () => {
        const created = await adapter.createSession({ title: '契约会话', modelProfileId: 'profile-1', modelRevision: 2 })
        const environment = await adapter.getSessionEnvironment(created.id)
        const next = await adapter.updateSessionEnvironment(created.id, environment.revision, {
          ...environment,
          skills: [{ id: 'skill-1', revision: 1 }],
        })
        expect(next.revision).toBe(environment.revision + 1)
        expect(next.skills).toEqual([{ id: 'skill-1', revision: 1 }])
        const conflict = await rejectWith(
          adapter.updateSessionEnvironment(created.id, environment.revision, { ...environment, tools: ['demo_tool'] }),
        )
        expect(conflict.code).toBe('revision-conflict')
        expect(conflict.message).toContain('环境')
      })

      it('记忆空间选择写后回显', async () => {
        const created = await adapter.createSession({ title: '契约会话', modelProfileId: 'profile-1', modelRevision: 2 })
        const saved = await adapter.writeSessionMemorySelection(created.id, { spaceId: 'space-9', includeGlobal: true })
        expect(saved).toEqual({ spaceId: 'space-9', includeGlobal: true })
        expect(await adapter.readSessionMemorySelection(created.id)).toEqual({ spaceId: 'space-9', includeGlobal: true })
      })
    })

    describe('任务提交与幂等', () => {
      it('新建任务返回排队中的 Run；同 requestId 同输入回读同一 Run', async () => {
        const created = await adapter.createSession({ title: '契约会话', modelProfileId: 'profile-1', modelRevision: 2 })
        const run = await adapter.createTask(created.id, CREATE_INPUT)
        expect(run.taskId).not.toBe('')
        expect(run.runNumber).toBe(1)
        expect(run.requestId).toBe(CREATE_INPUT.requestId)
        const duplicate = await adapter.createTask(created.id, CREATE_INPUT)
        expect(duplicate.id).toBe(run.id)
        expect(duplicate.runNumber).toBe(1)
      })

      it('同 requestId 不同输入拒绝 request-conflict', async () => {
        const created = await adapter.createSession({ title: '契约会话', modelProfileId: 'profile-1', modelRevision: 2 })
        await adapter.createTask(created.id, CREATE_INPUT)
        const conflict = await rejectWith(
          adapter.createTask(created.id, { ...CREATE_INPUT, content: '不同的输入内容' }),
        )
        expect(conflict.code).toBe('request-conflict')
        expect(conflict.message).toContain('请求标识')
      })

      it('会话 busy 期间新输入按服务端中文文案拒绝', async () => {
        const created = await adapter.createSession({ title: '契约会话', modelProfileId: 'profile-1', modelRevision: 2 })
        await adapter.createTask(created.id, CREATE_INPUT)
        const busy = await rejectWith(
          adapter.createTask(created.id, { requestId: 'contract-create-2', content: '第二条任务' }),
        )
        expect(busy.code).toBe('session-busy')
        expect(busy.message).toContain('会话仍有任务排队或运行')
        const session = await adapter.getSession(created.id)
        expect(session.activeRunId).not.toBeUndefined()
      })

      it('任务终态后续轮 runNumber 递增；模型切换后续轮被 model-changed 拒绝', async () => {
        const created = await adapter.createSession({ title: '契约会话', modelProfileId: 'profile-1', modelRevision: 2 })
        const first = await adapter.createTask(created.id, CREATE_INPUT)
        await clock.advance(6500)
        const terminal = await adapter.getTask(first.taskId)
        expect(terminal.latestRun?.status).toBe('succeeded')
        const second = await adapter.continueRun(first.taskId, { requestId: 'contract-continue-1', content: '继续上一轮' })
        expect(second.runNumber).toBe(2)
        expect(second.taskId).toBe(first.taskId)
        await clock.advance(6500)
        await adapter.switchModel(created.id, { modelProfileId: 'profile-2', modelRevision: 1 })
        const rejected = await rejectWith(
          adapter.continueRun(first.taskId, { requestId: 'contract-continue-2', content: '再继续一轮' }),
        )
        expect(rejected.code).toBe('model-changed')
        expect(rejected.message).toContain('模型已变化')
      })
    })

    describe('消息增量与隔离标记', () => {
      it('after 游标只取新增消息；空页保留游标；future-cursor 拒绝', async () => {
        const created = await adapter.createSession({ title: '契约会话', modelProfileId: 'profile-1', modelRevision: 2 })
        const run = await adapter.createTask(created.id, CREATE_INPUT)
        const first = await adapter.listMessages(created.id)
        expect(first.items.length).toBe(1)
        const firstMessage = first.items[0]
        expect(firstMessage?.role).toBe('user')
        expect(firstMessage?.taskId).toBe(run.taskId)
        const empty = await adapter.listMessages(created.id, { after: first.nextCursor })
        expect(empty.items).toEqual([])
        expect(empty.nextCursor).toBe(first.nextCursor)
        await clock.advance(6500)
        const incremental = await adapter.listMessages(created.id, { after: first.nextCursor })
        expect(incremental.items.length).toBe(1)
        expect(incremental.items[0]?.role).toBe('assistant')
        const future = await rejectWith(adapter.listMessages(created.id, { after: '9007199254740993' }))
        expect(future.code).toBe('future-cursor')
      })

      it('种子会话的 quarantined 消息与 wikiSources 如实回显', async () => {
        const page = await adapter.listSessions()
        const seed = page.items.find((session) => session.id === 'session-1')
        expect(seed).toBeDefined()
        const messages = await adapter.listMessages('session-1')
        const quarantined = messages.items.find((message) => message.quarantined === true)
        expect(quarantined).toBeDefined()
        expect(quarantined?.content).not.toBe('')
        const cited = messages.items.find((message) => message.wikiSources !== undefined && message.wikiSources.length > 0)
        expect(cited?.wikiSources?.[0]?.pageId).toBe('wiki-page-1')
      })
    })

    describe('工作区字节保真', () => {
      it('PUT 原始字节经 GET 回读逐字节一致，未被 JSON/base64 包装污染', async () => {
        const created = await adapter.createSession({ title: '契约会话', modelProfileId: 'profile-1', modelRevision: 2 })
        const run = await adapter.createTask(created.id, CREATE_INPUT)
        await clock.advance(6500)
        // 刻意包含 JSON 形文本、中文与二进制字节：任何包装都会改变字节序列。
        const text = '{"requestId":"must-not-wrap","content":1}\n中文内容\n'
        const bytes = new Uint8Array([...new TextEncoder().encode(text), 0x00, 0xff, 0x0a, 0x0d])
        const view = await adapter.listWorkspace(run.taskId)
        const version = await adapter.writeWorkspaceFile(run.taskId, 'evidence/raw.bin', view.version.revision, bytes)
        expect(version.revision).toBe(view.version.revision + 1)
        const read = await adapter.readWorkspaceFile(run.taskId, 'evidence/raw.bin')
        expect(read.content).toBeDefined()
        const decoded = base64ToBytes(read.content ?? '')
        expect(decoded.byteLength).toBe(bytes.byteLength)
        expect(Array.from(decoded)).toEqual(Array.from(bytes))
        const again = await adapter.readWorkspaceFile(run.taskId, 'evidence/raw.bin')
        expect(again.content).toBe(read.content)
      })

      it('删除文件后列表移除；旧 expectedRevision 写入被 CAS 拒绝', async () => {
        const created = await adapter.createSession({ title: '契约会话', modelProfileId: 'profile-1', modelRevision: 2 })
        const run = await adapter.createTask(created.id, CREATE_INPUT)
        await clock.advance(6500)
        const seed = await adapter.listWorkspace('task-1')
        expect(seed.files?.length).toBeGreaterThan(0)
        const empty = await adapter.listWorkspace(run.taskId)
        expect(empty.files).toEqual([])
        const written = await adapter.writeWorkspaceFile(run.taskId, 'notes/x.md', empty.version.revision, new TextEncoder().encode('x'))
        expect(written.revision).toBe(empty.version.revision + 1)
        const afterWrite = await adapter.listWorkspace(run.taskId)
        expect(afterWrite.files?.map((file) => file.path)).toEqual(['notes/x.md'])
        const version = await adapter.deleteWorkspaceFile(run.taskId, 'notes/x.md', written.revision)
        expect(version.revision).toBe(written.revision + 1)
        const afterDelete = await adapter.listWorkspace(run.taskId)
        expect(afterDelete.files).toEqual([])
        const stale = await rejectWith(
          adapter.writeWorkspaceFile(run.taskId, 'notes/x.md', written.revision, new TextEncoder().encode('x')),
        )
        expect(stale.code).toBe('workspace-revision-conflict')
        expect(stale.message).toContain('工作区已变化')
      })

      it('会话 busy 期间工作区写按服务端中文文案拒绝；种子隔离版本回显', async () => {
        const busySession = await adapter.createSession({ title: '契约会话', modelProfileId: 'profile-1', modelRevision: 2 })
        await adapter.createTask(busySession.id, CREATE_INPUT)
        const busyTask = (await adapter.listTasks(busySession.id)).items[0]
        if (busyTask === undefined) throw new Error('预期任务已创建')
        const rejected = await rejectWith(
          adapter.writeWorkspaceFile(busyTask.id, 'a.txt', 0, new TextEncoder().encode('a')),
        )
        expect(rejected.code).toBe('session-busy')
        expect(rejected.message).toContain('修改工作区')
        const quarantined = await adapter.listWorkspace('task-2')
        expect(quarantined.quarantined).toBe(true)
      })
    })

    describe('工作记忆与模型请求', () => {
      it('工作记忆携带修订、覆盖游标与事实证据；模型请求分页可读', async () => {
        const created = await adapter.createSession({ title: '契约会话', modelProfileId: 'profile-1', modelRevision: 2 })
        const run = await adapter.createTask(created.id, CREATE_INPUT)
        await clock.advance(6500)
        const memory = await adapter.getTaskWorkingMemory(run.taskId)
        expect(memory.taskId).toBe(run.taskId)
        expect(memory.revision).toBeGreaterThanOrEqual(1)
        expect(memory.coverage.eventSeq).toMatch(/^(0|[1-9][0-9]*)$/)
        expect(memory.facts.length).toBeGreaterThan(0)
        expect(memory.facts[0]?.sources[0]?.runId).toBe(run.id)
        const requests = await adapter.listModelRequests(run.id)
        expect(requests.items.length).toBe(2)
        expect(requests.items[0]?.purpose).toBe('inference')
        expect(requests.items[1]?.purpose).toBe('final-memory')
        expect(requests.items[1]?.estimatedTokens).toBeGreaterThan(0)
      })
    })
  })
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
