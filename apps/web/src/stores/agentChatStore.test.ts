import { describe, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentSession } from '@elysian/contracts'
import { agentChatSessionKey } from '../contracts/agentChat'
import type { AgentChatAdapter, AgentChatAttachment, AgentChatRun, AgentChatSession } from '../contracts/agentChat'
import type { ElysianGateway, SessionAdapter } from '../contracts/adapters'
import { createAgentChatStore, useAgentChatStore } from './agentChatStore'
import { useSessionStore } from './sessionStore'
import { chatTestApi, chatTestModel } from '../test/agentChatFixtures'
import { AgentHttpError } from '../adapters/http/agent/agentShared'

function localMemory() {
  let selected: string | undefined
  const records = new Map<string, AgentChatSession>()
  const listeners = new Set<() => void>()
  const files = new Map<string, File>()
  let sequence = 0
  const adapter: AgentChatAdapter = {
    read(key = selected) { const saved = records.get(key!); return saved ? structuredClone(saved) : null },
    list: () => [...records.values()].map(row => structuredClone(row)),
    select(key) { selected = key; return true },
    write(session, select = true) {
      const key = agentChatSessionKey(session)
      records.set(key, structuredClone(session))
      if (session.remote && session.id !== key) records.delete(session.id)
      if (select) selected = key
      return true
    },
    remove(key) {
      const record = records.get(key)
      records.delete(key)
      if (record) [...record.attachments, ...record.messages.flatMap(message => message.attachments)].forEach(attachment => files.delete(attachment.id))
      if (selected === key) selected = undefined
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async attach(input) {
      const attachments: AgentChatAttachment[] = input.map(file => {
        const id = `file-${++sequence}`
        files.set(id, file)
        return { id, name: file.name, size: file.size, type: file.type, lastModified: file.lastModified, available: true }
      })
      return { attachments, persisted: true }
    },
    async restore(attachments) { return attachments.map(attachment => ({ ...attachment, available: files.has(attachment.id) })) },
    async discard(ids) { ids.forEach(id => files.delete(id)) },
  }
  const makeStore = () => createAgentChatStore(adapter, () => '2026-10-12T00:00:00.000Z', () => `id-${++sequence}`)
  return { adapter, makeStore, files, publish: () => listeners.forEach(listener => listener()) }
}

describe('智能体本地会话', () => {
  it('刷新恢复草稿和服务端会话，并从 API 读取回复', async () => {
    const local = localMemory()
    const first = local.makeStore()
    await first.getState().ensureSession()
    first.getState().setDraft('检查容器日志')
    first.getState().setPermissionMode('assist')
    first.getState().setModel('model-1')
    first.getState().setReasoningLevel('high')
    const { api } = chatTestApi()
    expect(await first.getState().send(api, chatTestModel)).toBe(true)
    first.getState().setDraft('接下来查看磁盘')
    const second = local.makeStore()
    await second.getState().ensureSession()
    expect(second.getState().session).toEqual(first.getState().session)
    await second.getState().refresh(api)
    expect(second.getState().messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(api.createSession).toHaveBeenCalledOnce()
  })

  it('本地附件不会被伪装成已经发送给模型', async () => {
    const { makeStore } = localMemory()
    const store = makeStore()
    const { api } = chatTestApi()
    await store.getState().addAttachments([new File(['image'], 'diagram.png')])
    store.getState().setDraft('分析图片')
    expect(await store.getState().send(api, chatTestModel)).toBe(false)
    expect(api.createTask).not.toHaveBeenCalled()
    expect(store.getState().error).toContain('仅支持文本')
  })

  it('刷新后文件字节丢失时明确标记，不允许把文件名伪装成附件发送', async () => {
    const local = localMemory()
    const first = local.makeStore()
    await first.getState().addAttachments([new File(['a'], 'a.txt')])
    local.files.clear()
    const restored = local.makeStore()
    await restored.getState().ensureSession()
    expect(restored.getState().session?.attachments[0]?.available).toBe(false)
    expect(restored.getState().notice).toContain('无法从浏览器恢复')
    expect(await restored.getState().send(chatTestApi().api, chatTestModel)).toBe(false)
    expect(restored.getState().session?.messages).toEqual([])
  })

  it('另一标签选择新会话不覆盖当前标签的会话与草稿', async () => {
    const local = localMemory()
    const first = local.makeStore()
    await first.getState().ensureSession()
    first.getState().setDraft('旧草稿')
    const second = local.makeStore()
    await second.getState().ensureSession()
    const oldId = second.getState().session?.id
    await first.getState().newSession()
    local.publish()
    await Promise.resolve()
    expect(second.getState().session?.id).toBe(oldId)
    expect(second.getState().session?.draft).toBe('旧草稿')
    second.getState().setDraft('新草稿')
    expect(first.getState().session?.draft).toBe('')
    expect(second.getState().session?.draft).toBe('新草稿')
  })

  it('storage 事件尚未到达时编辑仍归属于当前标签的会话', async () => {
    const local = localMemory()
    const first = local.makeStore()
    const second = local.makeStore()
    await first.getState().ensureSession()
    await second.getState().ensureSession()
    await first.getState().newSession()
    second.getState().setDraft('继续输入')
    expect(local.adapter.read()?.id).toBe(second.getState().session?.id)
    expect(local.adapter.read()?.draft).toBe('继续输入')
    expect(first.getState().session?.draft).toBe('')
  })

  it('附件仍在保存期间重新登录，完成后清理附件并保持新会话空白', async () => {
    const local = localMemory()
    const originalAttach = local.adapter.attach
    let finish!: () => void
    let didStart!: () => void
    const started = new Promise<void>(resolve => { didStart = resolve })
    local.adapter.attach = async files => { await new Promise<void>(resolve => { finish = resolve; didStart() }); return originalAttach(files) }
    const store = local.makeStore()
    await store.getState().ensureSession()
    const pending = store.getState().addAttachments([new File(['a'], 'a.txt')])
    await started
    await store.getState().newSession()
    finish()
    await pending
    expect(store.getState().session?.attachments).toEqual([])
    expect(local.files.size).toBe(0)
  })
})

describe('基本聊天', () => {
  it('流式预览不写历史，最终回读原位确认，离开会话后忽略迟到增量', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    backend.hold()
    await store.getState().ensureSession()
    store.getState().setDraft('你好')
    await store.getState().send(backend.api, chatTestModel)
    let emit!: Parameters<typeof backend.api.stream>[1]
    backend.api.stream.mockImplementation(async (_id, onOutput, signal) => {
      emit = onOutput
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const controller = new AbortController()
    const watching = store.getState().watchOutput(backend.api, 'run-1', controller.signal)
    const output = { runId: 'run-1', responseId: 'm1', reasoning: '思考增量', content: '第一段', done: false }
    emit(output)
    expect(store.getState().liveOutput?.content).toBe('第一段')
    expect(store.getState().messages).toHaveLength(1)
    backend.complete('完整回答')
    await store.getState().refresh(backend.api)
    expect(store.getState().messages.at(-1)?.content).toBe('完整回答')
    await store.getState().newSession()
    emit({ ...output, content: '迟到内容' })
    expect(store.getState().liveOutput).toBeNull()
    controller.abort()
    await watching
    expect(backend.api.createTask).toHaveBeenCalledOnce()
  })

  it('思考快照随轮询替换，按轮次保留，读取失败仍保留回复和已显示内容', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    backend.hold()
    await store.getState().ensureSession()
    store.getState().setDraft('你好')
    backend.reasoning.set('run-1', '第一行')
    await store.getState().send(backend.api, chatTestModel)
    expect(store.getState().reasoning['run-1']).toBe('第一行')
    backend.reasoning.set('run-1', '第一行\n第二行')
    await store.getState().refresh(backend.api)
    expect(store.getState().reasoning['run-1']).toBe('第一行\n第二行')
    backend.complete('已完成')
    backend.api.reasoning.mockRejectedValueOnce(new Error('读取思考失败'))
    await store.getState().refresh(backend.api)
    expect(store.getState().messages.at(-1)?.content).toBe('已完成')
    expect(store.getState().reasoning['run-1']).toBe('第一行\n第二行')
    expect(store.getState().syncError).toBe('读取思考失败')
    await store.getState().newSession()
    expect(store.getState().reasoning).toEqual({})
  })

  it('首条消息创建任务，追问复用任务，不重复创建会话', async () => {
    const store = localMemory().makeStore()
    const { api } = chatTestApi()
    await store.getState().ensureSession()
    store.getState().setDraft('你好')
    expect(await store.getState().send(api, chatTestModel)).toBe(true)
    store.getState().setDraft('继续')
    expect(await store.getState().send(api, chatTestModel)).toBe(true)
    expect(api.createSession).toHaveBeenCalledOnce()
    expect(api.createTask).toHaveBeenCalledOnce()
    expect(api.continueTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ content: '继续' }))
    expect(store.getState().messages).toHaveLength(4)
    expect(store.getState().session?.draft).toBe('')
  })

  it('终态思考读取失败后，下一轮仍会补齐旧轮而不把增量当成完整缓存', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    backend.hold()
    await store.getState().ensureSession()
    store.getState().setDraft('第一条')
    backend.reasoning.set('run-1', '生成中的片段')
    await store.getState().send(backend.api, chatTestModel)
    backend.complete('第一轮答复')
    backend.reasoning.set('run-1', '第一轮完整思考')
    backend.api.reasoning.mockRejectedValueOnce(new Error('暂时读取失败'))
    await store.getState().refresh(backend.api)
    expect(store.getState().reasoning['run-1']).toBe('生成中的片段')

    store.getState().setDraft('继续')
    backend.reasoning.set('run-2', '第二轮思考')
    await store.getState().send(backend.api, chatTestModel)
    expect(store.getState().reasoning).toEqual({ 'run-1': '第一轮完整思考', 'run-2': '第二轮思考' })
    backend.api.reasoning.mockClear()
    await store.getState().refresh(backend.api)
    expect(backend.api.reasoning).toHaveBeenCalledExactlyOnceWith('run-2', undefined)
  })

  it('运行期间阻止再次发送，完成后读回回复', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    backend.hold()
    await store.getState().ensureSession()
    store.getState().setDraft('你好')
    await store.getState().send(backend.api, chatTestModel)
    store.getState().setDraft('下一条')
    expect(await store.getState().send(backend.api, chatTestModel)).toBe(false)
    backend.complete('第一条回复')
    await store.getState().refresh(backend.api)
    expect(store.getState().messages.at(-1)?.content).toBe('第一条回复')
    expect(store.getState().session?.draft).toBe('下一条')
  })

  it('明确失败保留草稿，不添加假的已发送消息', async () => {
    const store = localMemory().makeStore()
    const { api } = chatTestApi()
    api.createTask.mockRejectedValueOnce(new AgentHttpError('模型不可用', 'model-capability', 400))
    await store.getState().ensureSession()
    store.getState().setDraft('你好')
    expect(await store.getState().send(api, chatTestModel)).toBe(false)
    expect(store.getState().error).toBe('模型不可用')
    expect(store.getState().session?.draft).toBe('你好')
    expect(store.getState().messages).toEqual([])
    expect(store.getState().session?.pending).toBeUndefined()
  })

  it('响应丢失后手动重试沿用原请求，刷新和轮询不会重新提交', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const { api } = chatTestApi()
    api.createTask.mockRejectedValueOnce(new Error('网络失败'))
    await store.getState().ensureSession()
    store.getState().setDraft('你好')
    store.getState().setReasoningLevel('high')
    expect(await store.getState().send(api, chatTestModel)).toBe(false)
    expect(api.createTask.mock.calls[0]?.[1]).toMatchObject({ reasoningLevel: 'high' })
    const restored = local.makeStore()
    await restored.getState().ensureSession()
    restored.getState().setReasoningLevel('low')
    expect(restored.getState().session?.reasoningLevel).toBe('high')
    await restored.getState().refresh(api)
    expect(api.createTask).toHaveBeenCalledTimes(1)
    expect(await restored.getState().send(api, chatTestModel)).toBe(true)
    expect(api.createTask.mock.calls[1]).toEqual(api.createTask.mock.calls[0])
    expect(restored.getState().messages).toHaveLength(2)
  })

  it.each([
    ['forbidden-origin', 403], ['invalid-request', 400], ['input-too-large', 413],
    ['request-conflict', 409], ['unknown-rejection', 429], ['queue-full', 408], ['queue-full', 500],
  ])('响应丢失后的 %s/%s 拒绝仍保留精确请求，恢复后不会重复执行', async (code, status) => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    const submit = backend.api.createTask.getMockImplementation()!
    backend.api.createTask.mockImplementationOnce(async (...args) => {
      await submit(...args)
      throw new Error('回执丢失')
    }).mockRejectedValueOnce(new AgentHttpError('本次请求被拦截', code, status))
    await store.getState().ensureSession()
    store.getState().setDraft('只执行一次')
    expect(await store.getState().send(backend.api, chatTestModel)).toBe(false)
    const pending = store.getState().session!.pending!
    expect(backend.runs.size).toBe(1)

    expect(await store.getState().send(backend.api, chatTestModel)).toBe(false)
    expect(store.getState().session?.pending).toEqual(pending)
    expect(store.getState().error).toContain('发送结果尚未确认')
    store.getState().setDraft('不能替换尚未确认的输入')
    expect(store.getState().session?.draft).toBe('只执行一次')

    expect(await store.getState().send(backend.api, chatTestModel)).toBe(true)
    expect(backend.api.createTask.mock.calls.map(call => call[1])).toEqual([pending.input, pending.input, pending.input])
    expect(backend.runs.size).toBe(1)
    expect(store.getState().session?.pending).toBeUndefined()
    expect(store.getState().messages).toHaveLength(2)
  })

  it.each([
    ['unsupported-reasoning-level', 400], ['profile-not-found', 404], ['session-busy', 409], ['queue-full', 429],
  ])('幂等核对后的 %s/%s 业务拒绝解除未确认状态并允许修改草稿', async (code, status) => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    backend.api.createTask.mockRejectedValueOnce(new AgentHttpError('业务条件不满足', code, status))
    await store.getState().ensureSession()
    store.getState().setDraft('原输入')
    expect(await store.getState().send(backend.api, chatTestModel)).toBe(false)
    expect(store.getState().session?.pending).toBeUndefined()
    expect(store.getState().error).toBe('业务条件不满足')
    expect(backend.runs.size).toBe(0)
    store.getState().setDraft('已修正输入')
    expect(store.getState().session?.draft).toBe('已修正输入')
    expect(await store.getState().send(backend.api, chatTestModel)).toBe(true)
    expect(backend.api.createTask.mock.calls[1]?.[1].requestId).not.toBe(backend.api.createTask.mock.calls[0]?.[1].requestId)
  })

  it('未声明档位拒绝发送，切换模型清除旧选择，默认不强设思考参数', async () => {
    const store = localMemory().makeStore()
    const { api } = chatTestApi()
    await store.getState().ensureSession()
    store.getState().setDraft('你好')
    store.getState().setReasoningLevel('unknown')
    expect(await store.getState().send(api, chatTestModel)).toBe(false)
    expect(api.createTask).not.toHaveBeenCalled()
    store.getState().setModel(chatTestModel.id)
    expect(store.getState().session?.reasoningLevel).toBeNull()
    expect(await store.getState().send(api, chatTestModel)).toBe(true)
    expect(api.createTask.mock.calls[0]?.[1]).not.toHaveProperty('reasoningLevel')
  })

  it('会话失效后恢复同一草稿也不投递旧登录的迟到请求', async () => {
    const store = localMemory().makeStore()
    const { api, session } = chatTestApi()
    let resolve!: (value: typeof session) => void
    api.createSession.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await store.getState().ensureSession()
    store.getState().setDraft('旧输入')
    const sending = store.getState().send(api, chatTestModel)
    store.getState().clearDisplay()
    await store.getState().ensureSession()
    resolve(session)
    await sending
    expect(store.getState().session?.remote).toBeUndefined()
    expect(store.getState().messages).toEqual([])
    expect(api.createTask).not.toHaveBeenCalled()
  })
})

describe('登录与本地智能体会话', () => {
  const gateway = (session: Partial<SessionAdapter>) => ({ session } as unknown as ElysianGateway)

  it('登录探测、失败和成功均不新建对话，成功后恢复原草稿', async () => {
    const reset = vi.spyOn(useAgentChatStore.getState(), 'newSession').mockResolvedValue()
    try {
      await useSessionStore.getState().probe(gateway({ status: async () => ({ mode: 'real', authenticated: true, devAccount: false }) }))
      expect(reset).not.toHaveBeenCalled()
      await expect(useSessionStore.getState().login(gateway({ login: async () => { throw new Error('用户名或密码错误') } }), 'admin', 'bad')).rejects.toThrow()
      expect(reset).not.toHaveBeenCalled()
      await useSessionStore.getState().login(gateway({ login: async () => {} }), 'admin', 'good')
      expect(reset).not.toHaveBeenCalled()
    } finally { reset.mockRestore() }
  })
})

describe('多会话恢复与提交隔离', () => {
  it('指定会话立即切换，列表请求挂起时不能继续向旧会话发送', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    await store.getState().selectSession(backend.api, backend.session.id)
    store.getState().setDraft('留在旧会话的草稿')
    const target = { ...backend.session, id: 'target-session' }
    local.adapter.write({ ...store.getState().session!, id: 'target-local', remote: { sessionId: target.id }, draft: '目标会话的草稿' }, false)
    let resolveList!: (value: Awaited<ReturnType<typeof backend.api.listSessions>>) => void
    let resolveSession!: (value: typeof target) => void
    backend.api.listSessions.mockImplementationOnce(() => new Promise(done => { resolveList = done }))
    backend.api.getSession.mockImplementationOnce(() => new Promise(done => { resolveSession = done }))

    const navigation = store.getState().initialize(backend.api, target.id)
    expect(store.getState().session?.remote?.sessionId).toBe(target.id)
    expect(store.getState().session?.draft).toBe('目标会话的草稿')
    expect(store.getState().loading).toBe(true)
    expect(store.getState().remoteSession).toBeNull()
    expect(await store.getState().send(backend.api, chatTestModel)).toBe(false)
    expect(backend.api.createTask).not.toHaveBeenCalled()
    expect(backend.api.continueTask).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(resolveSession).toBeTypeOf('function'))
    expect(backend.api.getSession).toHaveBeenLastCalledWith(target.id, undefined)
    resolveSession(target)
    await vi.waitFor(() => expect(store.getState().remoteSession?.id).toBe(target.id))
    expect(store.getState().listLoading).toBe(true)
    expect(local.adapter.read(backend.session.id)?.draft).toBe('留在旧会话的草稿')
    resolveList({ items: [target, backend.session], nextCursor: '', hasMore: false })
    await navigation
    expect(store.getState().session?.remote?.sessionId).toBe(target.id)
  })

  it('静默更新保留已加载末页游标，下一次加载更多直接继续未读页', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    const row = (id: string, title = id) => ({ ...backend.session, id, title })
    backend.api.listSessions
      .mockResolvedValueOnce({ items: [row('a')], nextCursor: 'after-a', hasMore: true })
      .mockResolvedValueOnce({ items: [row('b')], nextCursor: 'after-b', hasMore: true })
      .mockResolvedValueOnce({ items: [row('new'), row('a', '会话已更新')], nextCursor: 'after-a', hasMore: true })
      .mockResolvedValueOnce({ items: [row('c')], nextCursor: '', hasMore: false })
      .mockResolvedValueOnce({ items: [row('new'), row('a')], nextCursor: 'after-a', hasMore: true })
      .mockResolvedValueOnce({ items: [row('new'), row('a')], nextCursor: 'after-a', hasMore: true })
    await store.getState().loadSessions(backend.api)
    await store.getState().loadSessions(backend.api, true)
    await store.getState().loadSessions(backend.api, false, true)
    expect(store.getState().sessions.map(session => session.id)).toEqual(['new', 'a', 'b'])
    expect(store.getState().sessions.find(session => session.id === 'a')?.title).toBe('会话已更新')
    expect(store.getState().listCursor).toBe('after-b')
    expect(store.getState().listHasMore).toBe(true)

    await store.getState().loadSessions(backend.api, true)
    expect(backend.api.listSessions).toHaveBeenLastCalledWith('after-b')
    expect(store.getState().sessions.map(session => session.id)).toEqual(['new', 'a', 'b', 'c'])
    await store.getState().loadSessions(backend.api, false, true)
    expect(store.getState().listCursor).toBe('')
    expect(store.getState().listHasMore).toBe(false)
    const callCount = backend.api.listSessions.mock.calls.length
    await store.getState().loadSessions(backend.api, true)
    expect(backend.api.listSessions).toHaveBeenCalledTimes(callCount)

    await store.getState().loadSessions(backend.api)
    expect(store.getState().sessions.map(session => session.id)).toEqual(['new', 'a'])
    expect(store.getState().listCursor).toBe('after-a')
    expect(store.getState().listHasMore).toBe(true)
  })

  it('首页读取失败后的首次静默成功仍初始化分页，登出清空分页基线', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    const page = { items: [backend.session], nextCursor: 'next-page', hasMore: true }
    backend.api.listSessions.mockRejectedValueOnce(new Error('连接失败')).mockResolvedValue(page)
    await store.getState().loadSessions(backend.api)
    await store.getState().loadSessions(backend.api, false, true)
    expect(store.getState().listCursor).toBe('next-page')
    expect(store.getState().listHasMore).toBe(true)
    store.getState().clearDisplay()
    await store.getState().loadSessions(backend.api, false, true)
    expect(store.getState().listCursor).toBe('next-page')
    expect(store.getState().listHasMore).toBe(true)
  })

  it('URL切换后，先前初始化的迟到响应不能改变新选择', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    let resolve!: (value: Awaited<ReturnType<typeof backend.api.listSessions>>) => void
    backend.api.listSessions.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const first = store.getState().initialize(backend.api, 'older')
    await store.getState().initialize(backend.api, backend.session.id)
    resolve({ items: [], nextCursor: '', hasMore: false })
    await first
    expect(store.getState().session?.remote?.sessionId).toBe(backend.session.id)
  })

  it('无本地指针时恢复最近历史及无答复的失败任务，沿用任务续轮', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    const failed = { id: 'failed-run', taskId: 'task-1', sessionId: backend.session.id, status: 'failed' as const }
    backend.api.listSessions.mockResolvedValue({ items: [backend.session], nextCursor: '', hasMore: false })
    backend.api.listTasks.mockResolvedValue({ items: [{ id: 'task-1', kind: 'agent', sessionId: backend.session.id }], nextCursor: '', hasMore: false })
    backend.api.getTask.mockResolvedValue({ id: 'task-1', kind: 'agent', sessionId: backend.session.id, latestRun: failed })
    await store.getState().initialize(backend.api)
    expect(store.getState().session?.remote).toMatchObject({ taskId: 'task-1', runId: 'failed-run' })
    expect(store.getState().run?.status).toBe('failed')
    store.getState().setDraft('再检查一次')
    await store.getState().send(backend.api, chatTestModel)
    expect(backend.api.continueTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ content: '再检查一次' }))
    expect(backend.api.createTask).not.toHaveBeenCalled()
  })

  it('运行期间允许新建并返回，保留旧草稿与附件', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    backend.hold()
    await store.getState().ensureSession()
    store.getState().setDraft('检查服务')
    await store.getState().send(backend.api, chatTestModel)
    store.getState().setDraft('下一条问题')
    await store.getState().newSession()
    await store.getState().addAttachments([new File(['a'], 'a.txt')])
    const draftKey = agentChatSessionKey(store.getState().session!)
    await store.getState().selectSession(backend.api, backend.session.id)
    expect(store.getState().session?.draft).toBe('下一条问题')
    expect(store.getState().run?.status).toBe('running')
    await store.getState().selectSession(backend.api, draftKey)
    expect(store.getState().session?.attachments[0]?.available).toBe(true)
  })

  it('两个远程会话并行运行互不污染，切回原会话仍是原运行', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    backend.hold()
    await store.getState().ensureSession()
    store.getState().setDraft('检查服务')
    await store.getState().send(backend.api, chatTestModel)
    store.getState().setDraft('追问 A')
    // 会话 B 是独立远程会话：路由到自己的任务、消息与运行，与 A 的服务端状态隔离。
    const sessionB: AgentSession = { ...backend.session, id: 'session-b', title: '会话 B', activeRunId: undefined }
    const messagesB: AgentMessage[] = []
    const runB: AgentChatRun = { id: 'run-b1', taskId: 'task-b', sessionId: 'session-b', status: 'running', phase: 'inference' }
    let submittedB = false
    const original = {
      createTask: backend.api.createTask.getMockImplementation()!,
      getSession: backend.api.getSession.getMockImplementation()!,
      listTasks: backend.api.listTasks.getMockImplementation()!,
      getTask: backend.api.getTask.getMockImplementation()!,
      messages: backend.api.messages.getMockImplementation()!,
      reasoning: backend.api.reasoning.getMockImplementation()!,
    }
    backend.api.getSession.mockImplementation(async id => id === 'session-b' ? { ...sessionB } : original.getSession(id))
    backend.api.listTasks.mockImplementation(async id => id === 'session-b'
      ? (submittedB ? { items: [{ id: 'task-b', sessionId: 'session-b', kind: 'agent' }], nextCursor: '', hasMore: false } : { items: [], nextCursor: '', hasMore: false })
      : original.listTasks(id))
    backend.api.getTask.mockImplementation(async (id: string) => id === 'task-b'
      ? { id: 'task-b', sessionId: 'session-b', kind: 'agent', latestRun: { ...runB } }
      : original.getTask(id))
    backend.api.messages.mockImplementation(async (id, after) => id === 'session-b'
      ? { items: messagesB.filter(message => BigInt(message.seq) > BigInt(after)), nextCursor: String(messagesB.length), hasMore: false }
      : original.messages(id, after))
    backend.api.reasoning.mockImplementation(async id => id === 'run-b1' ? '' : original.reasoning(id))
    backend.api.createTask.mockImplementation(async (id, input) => {
      if (id !== 'session-b') return original.createTask(id, input)
      submittedB = true
      sessionB.activeRunId = runB.id
      messagesB.push({ id: 'message-b1', seq: '1', role: 'user', content: input.content, taskId: runB.taskId, runId: runB.id, sessionId: 'session-b', createdAt: sessionB.createdAt })
      return { ...runB, requestId: input.requestId }
    })
    await store.getState().selectSession(backend.api, 'session-b')
    store.getState().setDraft('B 的问题')
    expect(await store.getState().send(backend.api, chatTestModel)).toBe(true)
    expect(store.getState().run).toMatchObject({ id: 'run-b1', sessionId: 'session-b' })
    expect(store.getState().messages).toHaveLength(1)
    expect(store.getState().messages[0]).toMatchObject({ sessionId: 'session-b', content: 'B 的问题' })
    // B 的提交不触碰 A 的本地记录：草稿、任务与运行指针原样。
    expect(local.adapter.read('server-session')).toMatchObject({ draft: '追问 A', remote: { sessionId: 'server-session', taskId: 'task-1', runId: 'run-1' } })
    await store.getState().selectSession(backend.api, 'server-session')
    expect(store.getState().run).toMatchObject({ id: 'run-1', status: 'running' })
    expect(store.getState().session?.draft).toBe('追问 A')
    expect(store.getState().messages).toHaveLength(1)
    expect(store.getState().messages[0]).toMatchObject({ sessionId: 'server-session', content: '检查服务' })
  })

  it('未确认消息切走后仍属于原会话，重试复用原 requestId', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    backend.api.createTask.mockRejectedValueOnce(new Error('连接中断'))
    await store.getState().ensureSession()
    store.getState().setDraft('确认一次')
    await store.getState().send(backend.api, chatTestModel)
    const pending = store.getState().session?.pending
    await store.getState().newSession()
    store.getState().setDraft('另一个草稿')
    await store.getState().selectSession(backend.api, backend.session.id)
    expect(store.getState().session?.pending).toEqual(pending)
    await store.getState().send(backend.api, chatTestModel)
    expect(backend.api.createTask.mock.calls[1]?.[1]).toEqual(pending?.input)
    expect(store.getState().session?.pending).toBeUndefined()
  })

  it('登出后的迟到提交回执只保存原记录，不回灌公开消息', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    let resolve!: (value: Awaited<ReturnType<typeof backend.api.createTask>>) => void
    backend.api.createTask.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await store.getState().ensureSession()
    store.getState().setDraft('原会话请求')
    const sending = store.getState().send(backend.api, chatTestModel)
    await vi.waitFor(() => expect(backend.api.createTask).toHaveBeenCalled())
    const requestId = local.adapter.read()?.pending?.input.requestId
    store.getState().clearDisplay()
    resolve({ id: 'late-run', taskId: 'task-1', sessionId: backend.session.id, requestId, status: 'running' })
    await sending
    expect(store.getState().session).toBeNull()
    expect(store.getState().messages).toEqual([])
    expect(local.adapter.read(backend.session.id)?.remote?.runId).toBe('late-run')
    expect(local.adapter.read(backend.session.id)?.pending).toBeUndefined()
  })

  it('网络故障保留原指针，只有会话本身404才提示回落', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    backend.api.getSession.mockRejectedValueOnce(new Error('连接失败'))
    await store.getState().selectSession(backend.api, 'missing')
    expect(store.getState().session?.remote?.sessionId).toBe('missing')
    expect(store.getState().syncError).toBe('连接失败')
    backend.api.getSession.mockRejectedValueOnce(new AgentHttpError('会话不存在', 'session-not-found', 404))
    await store.getState().refresh(backend.api)
    expect(store.getState().session?.remote).toBeUndefined()
    expect(store.getState().notice).toContain('原会话已不存在')
  })

  it('工作流活动运行不会成为聊天续轮指针，消息读取404也不会丢会话', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    backend.session.activeRunId = 'workflow-run'
    backend.api.getRun.mockResolvedValue({ id: 'workflow-run', taskId: 'workflow-task', sessionId: backend.session.id, status: 'running' })
    backend.api.listTasks.mockResolvedValue({ items: [{ id: 'workflow-task', kind: 'workflow', sessionId: backend.session.id }], nextCursor: '', hasMore: false })
    await store.getState().selectSession(backend.api, backend.session.id)
    expect(store.getState().run?.status).toBe('running')
    expect(store.getState().session?.remote?.taskId).toBeUndefined()
    backend.api.messages.mockRejectedValueOnce(new AgentHttpError('运行不存在', 'run-not-found', 404))
    await store.getState().refresh(backend.api)
    expect(store.getState().session?.remote?.sessionId).toBe(backend.session.id)
    expect(store.getState().syncError).toBe('运行不存在')
  })
})

describe('会话重命名与删除', () => {
  async function preparedStore() {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    const a = { ...backend.session, id: 'session-a', title: '会话 A' }
    const b = { ...backend.session, id: 'session-b', title: '会话 B' }
    backend.api.listSessions.mockResolvedValue({ items: [a, b], nextCursor: 'cursor-1', hasMore: true })
    backend.api.getSession.mockImplementation(async (id: string) => id === 'session-a' ? { ...a } : { ...b })
    backend.api.renameSession.mockImplementation(async (id: string, input: { title: string }) => ({ ...backend.session, id, title: input.title.trim() }))
    await store.getState().initialize(backend.api)
    return { local, store, backend, a, b }
  }

  it('重命名以服务端回执覆盖列表行与页头标题，提交 TrimSpace 后的标题', async () => {
    const { store, backend } = await preparedStore()
    expect(store.getState().remoteSession?.id).toBe('session-a')
    await store.getState().renameSession(backend.api, 'session-a', '  新标题  ')
    expect(backend.api.renameSession).toHaveBeenCalledExactlyOnceWith('session-a', { title: '新标题' })
    expect(store.getState().sessions.find(row => row.id === 'session-a')?.title).toBe('新标题')
    expect(store.getState().remoteSession?.title).toBe('新标题')
    expect(store.getState().sessions.find(row => row.id === 'session-b')?.title).toBe('会话 B')
  })

  it('重命名404按会话消失处理，过滤行并给出提示', async () => {
    const { store, backend } = await preparedStore()
    backend.api.renameSession.mockRejectedValueOnce(new AgentHttpError('Agent 会话不存在', 'session-not-found', 404))
    await store.getState().renameSession(backend.api, 'session-b', '新名')
    expect(store.getState().sessions.map(row => row.id)).toEqual(['session-a'])
    expect(store.getState().notice).toContain('原会话已不存在')
  })

  it('重命名其他错误原样上抛，列表不动', async () => {
    const { store, backend } = await preparedStore()
    backend.api.renameSession.mockRejectedValueOnce(new AgentHttpError('会话标题不能超过 200 字节', 'invalid-title', 400))
    await expect(store.getState().renameSession(backend.api, 'session-b', 'x'.repeat(201))).rejects.toThrow('会话标题不能超过 200 字节')
    expect(store.getState().sessions.find(row => row.id === 'session-b')?.title).toBe('会话 B')
  })

  it('删除非当前会话只移除该行，清理本地记录与附件字节，分页游标不动', async () => {
    const { local, store, backend } = await preparedStore()
    const attached = await local.adapter.attach([new File(['b'], 'b.txt')])
    local.adapter.write({ id: 'draft:b', createdAt: '2026-10-12T00:00:00.000Z', draft: 'B 草稿', messages: [], attachments: attached.attachments, permissionMode: 'ask', modelId: null, reasoningLevel: null, remote: { sessionId: 'session-b' } }, false)
    await store.getState().deleteSession(backend.api, 'session-b')
    expect(store.getState().sessions.map(row => row.id)).toEqual(['session-a'])
    expect(store.getState().remoteSession?.id).toBe('session-a')
    expect(store.getState().notice).toBeNull()
    expect(store.getState().listCursor).toBe('cursor-1')
    expect(store.getState().listHasMore).toBe(true)
    expect(local.adapter.read('session-b')).toBeNull()
    expect(local.files.size).toBe(0)
  })

  it('删除当前选中会话回落到剩余第一个会话并以 notice 说明去向', async () => {
    const { store, backend } = await preparedStore()
    expect(store.getState().remoteSession?.id).toBe('session-a')
    await store.getState().deleteSession(backend.api, 'session-a')
    expect(store.getState().sessions.map(row => row.id)).toEqual(['session-b'])
    expect(store.getState().remoteSession?.id).toBe('session-b')
    expect(store.getState().notice).toBe('会话已删除，已切换到其他会话。')
  })

  it('删除最后一个会话回落到空白草稿并以 notice 说明去向', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    backend.api.listSessions.mockResolvedValue({ items: [{ ...backend.session, id: 'only', title: '唯一会话' }], nextCursor: '', hasMore: false })
    backend.api.getSession.mockResolvedValue({ ...backend.session, id: 'only' })
    await store.getState().initialize(backend.api)
    expect(store.getState().remoteSession?.id).toBe('only')
    await store.getState().deleteSession(backend.api, 'only')
    expect(store.getState().sessions).toEqual([])
    expect(store.getState().session?.remote).toBeUndefined()
    expect(store.getState().notice).toBe('会话已删除，已新建空白会话。')
  })

  it('删除404幂等视为已删，仍完成本地清理', async () => {
    const { store, backend } = await preparedStore()
    backend.api.deleteSession.mockRejectedValueOnce(new AgentHttpError('Agent 会话不存在', 'session-not-found', 404))
    await store.getState().deleteSession(backend.api, 'session-b')
    expect(store.getState().sessions.map(row => row.id)).toEqual(['session-a'])
  })

  it.each([
    ['session-busy', 409, '会话仍有任务排队或运行，请结束后再删除'],
    ['session-unresolved', 409, '会话存在结果未确认的执行（如面板重启时的在途操作），暂不能删除；需经执行对账接口确认停止后解除'],
  ])('删除被 %s 拒绝时不做本地清理并透传服务端文案', async (code, status, message) => {
    const { local, store, backend } = await preparedStore()
    local.adapter.write({ id: 'draft:b', createdAt: '2026-10-12T00:00:00.000Z', draft: 'B 草稿', messages: [], attachments: [], permissionMode: 'ask', modelId: null, reasoningLevel: null, remote: { sessionId: 'session-b' } }, false)
    backend.api.deleteSession.mockRejectedValueOnce(new AgentHttpError(message, code, status))
    await expect(store.getState().deleteSession(backend.api, 'session-b')).rejects.toThrow(message)
    expect(store.getState().sessions.map(row => row.id)).toEqual(['session-a', 'session-b'])
    expect(local.adapter.read('session-b')).toMatchObject({ draft: 'B 草稿' })
  })

  it('发送在途时拒绝重命名与删除', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    store.getState().setDraft('你好')
    backend.api.createSession.mockImplementationOnce(() => new Promise(() => {}))
    void store.getState().send(backend.api, chatTestModel)
    expect(store.getState().sending).toBe(true)
    await store.getState().renameSession(backend.api, backend.session.id, '新名')
    await store.getState().deleteSession(backend.api, backend.session.id)
    expect(backend.api.renameSession).not.toHaveBeenCalled()
    expect(backend.api.deleteSession).not.toHaveBeenCalled()
  })
})
