import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentSession } from '@elysian/contracts'
import { agentChatSessionKey } from '../contracts/agentChat'
import type { AgentChatAdapter, AgentChatAttachment, AgentChatRun, AgentChatSession } from '../contracts/agentChat'
import type { ElysianGateway, SessionAdapter } from '../contracts/adapters'
import { createAgentChatStore, useAgentChatStore } from './agentChatStore'
import { useSessionStore } from './sessionStore'
import { chatTestApi, chatTestModel, chatVisionTestModel } from '../test/agentChatFixtures'
import { AgentHttpError } from '../adapters/http/agent/agentShared'
import { prepareAgentImage } from '../adapters/local/agentImagePreparation'
import { useNotificationStore } from './notificationStore'

vi.mock('../adapters/local/agentImagePreparation', () => ({ prepareAgentImage: vi.fn(async (file: File) => file) }))
beforeEach(() => {
  useNotificationStore.getState().clear()
  vi.mocked(prepareAgentImage).mockReset().mockImplementation(async file => file)
})

const notificationMessage = () => useNotificationStore.getState().notifications.at(-1)?.message

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

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
  it('编辑替换最后一轮并清除旧思考，其他标签和刷新读取一致，底部草稿保留', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    store.getState().setDraft('第一问')
    await store.getState().send(backend.api, chatTestModel)
    store.getState().setDraft('第二问')
    await store.getState().send(backend.api, chatTestModel)
    backend.reasoning.set('run-2', '旧思考')
    await store.getState().refresh(backend.api)
    const other = local.makeStore()
    await other.getState().ensureSession()
    await other.getState().refresh(backend.api)
    const skipped = local.makeStore()
    await skipped.getState().ensureSession()
    await skipped.getState().refresh(backend.api)
    store.getState().setDraft('底部草稿')
    store.getState().editMessage('message-1')
    expect(store.getState().session?.editing).toBeUndefined()
    store.getState().editMessage('message-3')
    store.getState().setEditText('修改第二问')
    backend.hold()
    const readMessages = backend.api.messages.getMockImplementation()!
    let finishRead!: () => void
    backend.api.messages.mockImplementationOnce(async (...args) => {
      await new Promise<void>(resolve => { finishRead = resolve })
      return readMessages(...args)
    })
    const sending = store.getState().send(backend.api, chatTestModel)
    await vi.waitFor(() => expect(finishRead).toBeDefined())
    expect(store.getState().messages.map(message => message.content)).toEqual(['第一问', '你好，我是 Ely。', '修改第二问'])
    expect(store.getState().reasoning['run-2']).toBeUndefined()
    finishRead()
    expect(await sending).toBe(true)
    expect(store.getState().session?.draft).toBe('底部草稿')
    expect(store.getState().session?.editing).toBeUndefined()
    expect(store.getState().messages.map(message => message.content)).toEqual(['第一问', '你好，我是 Ely。', '修改第二问'])
    expect(store.getState().reasoning['run-2']).toBeUndefined()
    expect(backend.api.continueTask).toHaveBeenLastCalledWith('task-1', expect.objectContaining({ content: '修改第二问', replaceMessageId: 'message-3' }))
    await other.getState().refresh(backend.api)
    expect(other.getState().messages).toEqual(store.getState().messages)
    const restored = local.makeStore()
    await restored.getState().ensureSession()
    await restored.getState().refresh(backend.api)
    expect(restored.getState().messages).toEqual(store.getState().messages)
    backend.complete('修改后的答复')
    await store.getState().refresh(backend.api)
    store.getState().editMessage('message-5')
    store.getState().setEditText('再次修改第二问')
    await store.getState().send(backend.api, chatTestModel)
    await skipped.getState().refresh(backend.api)
    await other.getState().refresh(backend.api)
    expect(skipped.getState().messages).toEqual(store.getState().messages)
    expect(other.getState().messages).toEqual(store.getState().messages)
    expect(store.getState().messages.map(message => message.content)).toEqual(['第一问', '你好，我是 Ely。', '再次修改第二问'])
  })

  it.each(['手动重试', '回读确认'])('编辑发送回执丢失后保留精确请求，%s不重复生成或清除新消息', async mode => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    store.getState().setDraft('原消息')
    await store.getState().send(backend.api, chatTestModel)
    store.getState().setDraft('保留草稿')
    store.getState().editMessage('message-1')
    store.getState().setEditText('更正消息')
    const submit = backend.api.continueTask.getMockImplementation()!
    backend.api.continueTask.mockImplementationOnce(async (...args) => { await submit(...args); throw new Error('回执丢失') })
    expect(await store.getState().send(backend.api, chatTestModel)).toBe(false)
    const pending = store.getState().session!.pending!
    store.getState().setEditText('不应修改')
    expect(store.getState().session?.editing?.text).toBe('更正消息')
    const restored = local.makeStore()
    await restored.getState().ensureSession()
    if (mode === '手动重试') expect(await restored.getState().send(backend.api, chatTestModel)).toBe(true)
    else await restored.getState().refresh(backend.api)
    expect(backend.api.continueTask).toHaveBeenLastCalledWith('task-1', pending.input)
    expect(backend.runs.size).toBe(2)
    expect(restored.getState().session?.draft).toBe('保留草稿')
    expect(restored.getState().session?.pending).toBeUndefined()
    expect(restored.getState().messages.map(message => message.content)).toEqual(['更正消息', '你好，我是 Ely。'])
  })

  it('停止复用取消接口，确认停止前锁定编辑，失败后允许重试', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    backend.hold()
    await store.getState().ensureSession()
    store.getState().setDraft('等待回复')
    await store.getState().send(backend.api, chatTestModel)
    store.getState().editMessage('message-1')
    expect(store.getState().session?.editing).toBeUndefined()
    backend.api.cancelRun.mockRejectedValueOnce(new Error('取消请求失败'))
    await store.getState().stop(backend.api)
    expect(notificationMessage()).toBe('取消请求失败')
    expect(store.getState().stopping).toBe(false)
    await store.getState().stop(backend.api)
    expect(store.getState().run?.status).toBe('cancelled')
    store.getState().editMessage('message-1')
    expect(store.getState().session?.editing?.text).toBe('等待回复')
  })

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

  it('旧版本添加的无 serverId 存量附件被显式拦截，不产出附件引用也不静默丢图', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const { api } = chatTestApi()
    await store.getState().ensureSession()
    // 直接写入无 serverId 的草稿附件：模拟升级前旧版记录（旧版上传通道不存在）。
    store.getState().session!.attachments = [{ id: 'legacy-1', name: 'diagram.png', size: 10, type: 'image/png', lastModified: 0, available: true }]
    store.getState().setDraft('分析图片')
    expect(await store.getState().send(api, chatVisionTestModel)).toBe(false)
    expect(api.createTask).not.toHaveBeenCalled()
    expect(notificationMessage()).toContain('存在未上传的附件')
    expect(notificationMessage()).toContain('diagram.png')
    // 被拦截的输入不写 pending，重试也不会产出空引用。
    expect(store.getState().session?.pending).toBeUndefined()
  })

  it('上传链路把附件字节送入服务端并随消息提交引用', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    const file = new File(['image'], 'diagram.png', { type: 'image/png' })
    await store.getState().addAttachments(backend.api, [file])
    expect(backend.api.uploadAttachments).toHaveBeenCalledOnce()
    const draft = store.getState().session?.attachments[0]
    expect(draft?.serverId).toBe('server-attachment-1')
    expect(draft?.available).toBe(true)
    store.getState().setDraft('分析图片')
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(true)
    expect(backend.api.createTask).toHaveBeenCalledWith('server-session', expect.objectContaining({
      content: '分析图片', attachments: [{ id: 'server-attachment-1' }],
    }))
    // 确认接受后草稿附件清空并释放本地字节。
    expect(store.getState().session?.attachments).toEqual([])
    expect(local.files.size).toBe(0)
  })

  it('八张大图压缩后恰好 8 MiB 接受，本地保存与上传使用同一份文件', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    const originals = Array.from({ length: 8 }, (_, index) => new File([new ArrayBuffer(2 * 1048576)], `${index}.png`, { type: 'image/png' }))
    const prepared = originals.map((file, index) => new File([new ArrayBuffer(1048576)], `${index}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified }))
    prepared.forEach(file => vi.mocked(prepareAgentImage).mockResolvedValueOnce(file))
    await store.getState().addAttachments(backend.api, originals)
    expect(prepareAgentImage).toHaveBeenCalledTimes(8)
    expect(backend.api.uploadAttachments).toHaveBeenCalledWith(prepared, expect.any(AbortSignal))
    expect([...local.files.values()]).toEqual(prepared)
    expect(store.getState().session?.attachments.map(item => ({ size: item.size, type: item.type })))
      .toEqual(prepared.map(() => ({ size: 1048576, type: 'image/jpeg' })))
  })

  it('超过 50 张小图可加入草稿并携带全部引用发送', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    const files = Array.from({ length: 51 }, (_, index) => new File(['x'], `${index}.png`, { type: 'image/png' }))
    await store.getState().addAttachments(backend.api, files)
    expect(store.getState().session?.attachments).toHaveLength(51)
    expect(backend.api.uploadAttachments).toHaveBeenCalledWith(files, expect.any(AbortSignal))
    store.getState().setDraft('分析这组图片')
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(true)
    expect(backend.api.createTask.mock.lastCall?.[1].attachments).toEqual(
      files.map((_, index) => ({ id: `server-attachment-${index + 1}` })),
    )
  })

  it('压缩后合计超过 8 MiB 一个字节时整批拒绝，保留草稿且不上传', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    store.getState().setDraft('保留输入')
    const files = Array.from({ length: 8 }, (_, index) => new File([new ArrayBuffer(1048576)], `${index}.png`, { type: 'image/png' }))
    files.push(new File(['x'], 'extra.png', { type: 'image/png' }))
    await store.getState().addAttachments(backend.api, files)
    expect(notificationMessage()).toBe('本条消息附件合计超过 8 MiB，请分批发送。')
    expect(backend.api.uploadAttachments).not.toHaveBeenCalled()
    expect(store.getState().session?.attachments).toEqual([])
    expect(store.getState().session?.draft).toBe('保留输入')
    expect(store.getState().uploadingAttachments).toBe(false)
    expect(local.files.size).toBe(0)
  })

  it.each([0, 1])('累计既有图片和本批压缩后字节，8 MiB 边界额外 %s 字节', async extra => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    const existing = Array.from({ length: 7 }, (_, index) => new File([new ArrayBuffer(1048576)], `${index}.png`, { type: 'image/png' }))
    await store.getState().addAttachments(backend.api, existing)
    const before = store.getState().session!.attachments
    backend.api.uploadAttachments.mockClear()
    const original = new File([new ArrayBuffer(2 * 1048576)], 'new.png', { type: 'image/png' })
    const compressed = new File([new ArrayBuffer(1048576)], 'new.jpg', { type: 'image/jpeg' })
    vi.mocked(prepareAgentImage).mockResolvedValueOnce(compressed)
    await store.getState().addAttachments(backend.api, [original, ...(extra ? [new File(['x'], 'extra.png', { type: 'image/png' })] : [])])
    if (extra) {
      expect(notificationMessage()).toBe('本条消息附件合计超过 8 MiB，请分批发送。')
      expect(backend.api.uploadAttachments).not.toHaveBeenCalled()
      expect(store.getState().session?.attachments).toEqual(before)
      expect(local.files.size).toBe(7)
    } else {
      expect(backend.api.uploadAttachments).toHaveBeenCalledWith([compressed], expect.any(AbortSignal))
      expect(store.getState().session?.attachments).toHaveLength(8)
      expect([...local.files.values()].at(-1)).toBe(compressed)
      expect(useNotificationStore.getState().notifications).toEqual([])
    }
  })

  it('旧草稿单图均合规但总量超限时发送被拦截，不创建会话或 pending', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    store.getState().setDraft('旧图草稿')
    const attachments = Array.from({ length: 9 }, (_, index) => ({
      id: `local-${index}`, serverId: `server-${index}`, name: `${index}.png`, size: 1048576,
      type: 'image/png', lastModified: 0, available: false, width: 1, height: 1,
    }))
    store.getState().session!.attachments = attachments
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(false)
    expect(notificationMessage()).toBe('本条消息附件合计超过 8 MiB，请分批发送。')
    expect(store.getState().session?.pending).toBeUndefined()
    expect(store.getState().session?.attachments).toEqual(attachments)
    expect(store.getState().session?.draft).toBe('旧图草稿')
    expect(backend.api.createSession).not.toHaveBeenCalled()
    expect(backend.api.createTask).not.toHaveBeenCalled()
    expect(backend.api.attachmentBlob).not.toHaveBeenCalled()
    expect(backend.api.uploadAttachments).not.toHaveBeenCalled()
  })

  it('升级前未确认 pending 超过新总量时原样重试，跳过压缩、模型与新总量校验', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    const attachments = Array.from({ length: 9 }, (_, index) => ({
      id: `local-${index}`, serverId: `server-${index}`, name: `${index}.png`, size: 1048576,
      type: 'image/png', lastModified: 0, available: false, width: 1, height: 1,
    }))
    const input = { requestId: 'old-pending-request', content: '旧输入', attachments: attachments.map(item => ({ id: item.serverId })) }
    local.adapter.write({ ...store.getState().session!, draft: '旧输入', attachments, remote: { sessionId: backend.session.id }, pending: { input } })
    store.getState().clearDisplay()
    await store.getState().ensureSession()
    useNotificationStore.getState().clear()
    expect(await store.getState().send(backend.api)).toBe(true)
    expect(backend.api.createTask).toHaveBeenCalledExactlyOnceWith(backend.session.id, input)
    expect(prepareAgentImage).not.toHaveBeenCalled()
    expect(backend.api.attachmentBlob).not.toHaveBeenCalled()
    expect(backend.api.uploadAttachments).not.toHaveBeenCalled()
    expect(store.getState().session?.pending).toBeUndefined()
    expect(useNotificationStore.getState().notifications).toEqual([])
  })

  it('整批图片处理失败时不上传任何图片，草稿和既有附件保留', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    store.getState().setDraft('保留输入')
    const first = new File(['png'], 'a.png', { type: 'image/png' })
    await store.getState().addAttachments(backend.api, [first])
    const prior = store.getState().session?.attachments
    backend.api.uploadAttachments.mockClear()
    vi.mocked(prepareAgentImage).mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('图片“bad.png”无法解码'))
    await store.getState().addAttachments(backend.api, [first, new File(['invalid'], 'bad.png', { type: 'image/png' })])
    expect(backend.api.uploadAttachments).not.toHaveBeenCalled()
    expect(store.getState().session?.attachments).toEqual(prior)
    expect(store.getState().session?.draft).toBe('保留输入')
    expect(notificationMessage()).toContain('bad.png')
  })

  it('旧草稿超限图片发送前压缩，刷新后的重试固定新附件且释放旧本地字节', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    const oldFile = new File([new ArrayBuffer(2 * 1048576)], 'old.png', { type: 'image/png' })
    const uploaded = await backend.api.uploadAttachments([oldFile])
    const attached = await local.adapter.attach([oldFile])
    local.adapter.write({ ...store.getState().session!, draft: '旧图', attachments: [{ ...attached.attachments[0]!, serverId: uploaded.items[0]!.id }] })
    await store.getState().clearDisplay()
    await store.getState().ensureSession()
    backend.api.uploadAttachments.mockClear()
    const compressed = new File(['jpeg'], 'old.jpg', { type: 'image/jpeg' })
    vi.mocked(prepareAgentImage).mockResolvedValueOnce(compressed)
    backend.api.createTask.mockRejectedValueOnce(new Error('回执丢失'))
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(false)
    const pending = store.getState().session!.pending!
    expect(pending.input.attachments).toEqual([{ id: 'server-attachment-2' }])
    expect(backend.api.attachmentBlob).toHaveBeenCalledWith('server-attachment-1', expect.any(AbortSignal))
    expect([...local.files.values()]).toEqual([compressed])
    const refreshed = local.makeStore()
    await refreshed.getState().ensureSession()
    expect(await refreshed.getState().send(backend.api, chatVisionTestModel)).toBe(true)
    expect(backend.api.createTask).toHaveBeenLastCalledWith('server-session', pending.input)
    expect(prepareAgentImage).toHaveBeenCalledOnce()
    expect(backend.api.uploadAttachments).toHaveBeenCalledOnce()
    expect(local.files.size).toBe(0)
  })

  it('编辑重发压缩超限旧图，明确拒绝后刷新复用处理结果，不改原历史或底部附件', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    const old = await backend.api.uploadAttachments([new File([new ArrayBuffer(2 * 1048576)], 'old.png', { type: 'image/png' })])
    await backend.api.createTask('server-session', { requestId: 'old', content: '原消息', attachments: [{ id: old.items[0]!.id }] })
    await store.getState().initialize(backend.api, 'server-session')
    const original = backend.messages[0]!
    const originalAttachments = structuredClone(original.attachments)
    await store.getState().addAttachments(backend.api, [new File(['draft'], 'draft.png', { type: 'image/png' })])
    const bottom = store.getState().session!.attachments
    store.getState().editMessage(original.id)
    store.getState().setEditText('修改消息')
    backend.api.uploadAttachments.mockClear()
    vi.mocked(prepareAgentImage).mockClear().mockResolvedValueOnce(new File(['jpeg'], 'old.jpg', { type: 'image/jpeg' }))
    backend.api.continueTask.mockRejectedValueOnce(new AgentHttpError('暂时繁忙', 'queue-full', 429))
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(false)
    expect(store.getState().session?.pending).toBeUndefined()
    expect(store.getState().session?.editing?.preparedAttachments?.[0]?.sourceId).toBe(old.items[0]!.id)
    const refreshed = local.makeStore()
    await refreshed.getState().ensureSession()
    await refreshed.getState().refresh(backend.api)
    expect(await refreshed.getState().send(backend.api, chatVisionTestModel)).toBe(true)
    expect(backend.api.continueTask).toHaveBeenLastCalledWith('task-1', expect.objectContaining({ attachments: [{ id: 'server-attachment-3' }] }))
    expect(backend.api.uploadAttachments).toHaveBeenCalledOnce()
    expect(prepareAgentImage).toHaveBeenCalledOnce()
    expect(original.attachments).toEqual(originalAttachments)
    expect(refreshed.getState().session?.attachments).toEqual(bottom)
    expect(local.files.size).toBe(1)
  })

  it('编辑图片缓存失效的明确拒绝清理缓存，刷新后重新压缩且保留编辑文本', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    const old = await backend.api.uploadAttachments([new File([new ArrayBuffer(2 * 1048576)], 'old.png', { type: 'image/png' })])
    await backend.api.createTask('server-session', { requestId: 'old', content: '原消息', attachments: [{ id: old.items[0]!.id }] })
    await store.getState().initialize(backend.api, 'server-session')
    const original = backend.messages[0]!
    store.getState().editMessage(original.id)
    store.getState().setEditText('保留修改后的问题')
    backend.api.uploadAttachments.mockClear()
    vi.mocked(prepareAgentImage).mockResolvedValueOnce(new File(['first'], 'first.jpg', { type: 'image/jpeg' }))
    backend.api.continueTask.mockRejectedValueOnce(new AgentHttpError('暂时繁忙', 'queue-full', 429))
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(false)
    const cached = store.getState().session!.editing!.preparedAttachments![0]!.attachment
    expect(local.files.has(cached.id)).toBe(true)
    expect(cached.serverId).toBe('server-attachment-2')
    backend.attachments.delete(cached.serverId!)
    backend.api.continueTask.mockRejectedValueOnce(new AgentHttpError('附件不存在或已被使用', 'attachment-invalid', 400))

    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(false)
    const invalidInput = backend.api.continueTask.mock.calls[1]![1]
    const exactInvalidInput = structuredClone(invalidInput)
    expect(invalidInput.attachments).toEqual([{ id: cached.serverId }])
    expect(store.getState().session?.pending).toBeUndefined()
    expect(store.getState().session?.editing).toMatchObject({
      messageId: original.id, text: '保留修改后的问题', attachments: [{ id: old.items[0]!.id }],
    })
    expect(store.getState().session?.editing?.preparedAttachments).toBeUndefined()
    expect(local.files.has(cached.id)).toBe(false)
    expect(prepareAgentImage).toHaveBeenCalledOnce()

    const restored = local.makeStore()
    await restored.getState().ensureSession()
    await restored.getState().refresh(backend.api)
    vi.mocked(prepareAgentImage).mockResolvedValueOnce(new File(['fresh'], 'fresh.jpg', { type: 'image/jpeg' }))
    expect(await restored.getState().send(backend.api, chatVisionTestModel)).toBe(true)
    expect(backend.api.continueTask).toHaveBeenLastCalledWith('task-1', expect.objectContaining({
      content: '保留修改后的问题', replaceMessageId: original.id, attachments: [{ id: 'server-attachment-3' }],
    }))
    expect(prepareAgentImage).toHaveBeenCalledTimes(2)
    expect(backend.api.uploadAttachments).toHaveBeenCalledTimes(2)
    expect(invalidInput).toEqual(exactInvalidInput)
    expect(local.files.size).toBe(0)
  })

  it('旧图处理期间刷新到其他标签的新消息，中止过期编辑且不上传或写坏本地会话', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    const old = await backend.api.uploadAttachments([new File([new ArrayBuffer(2 * 1048576)], 'old.png', { type: 'image/png' })])
    await backend.api.createTask('server-session', { requestId: 'old', content: '原消息', attachments: [{ id: old.items[0]!.id }] })
    await store.getState().initialize(backend.api, 'server-session')
    store.getState().setDraft('底部草稿')
    store.getState().editMessage(backend.messages[0]!.id)
    store.getState().setEditText('过期的修改')
    const preparing = deferred<File>()
    vi.mocked(prepareAgentImage).mockReturnValueOnce(preparing.promise)
    backend.api.uploadAttachments.mockClear()
    backend.api.continueTask.mockClear()
    const sending = store.getState().send(backend.api, chatVisionTestModel)
    await vi.waitFor(() => expect(prepareAgentImage).toHaveBeenCalledOnce())

    await backend.api.continueTask('task-1', { requestId: 'other-tab', content: '其他标签的新消息' })
    await store.getState().refresh(backend.api)
    expect(store.getState().session?.editing).toBeUndefined()
    preparing.resolve(new File(['jpeg'], 'prepared.jpg', { type: 'image/jpeg' }))
    expect(await sending).toBe(false)
    expect(backend.api.uploadAttachments).not.toHaveBeenCalled()
    expect(backend.api.continueTask).toHaveBeenCalledOnce()
    expect(store.getState().session?.editing).toBeUndefined()
    expect(store.getState().session?.pending).toBeUndefined()
    expect(store.getState().session?.draft).toBe('底部草稿')
    expect(store.getState().sending).toBe(false)
    expect(notificationMessage()).toBe('原消息已变化，请重新选择需要编辑的消息。')
    expect(local.files.size).toBe(0)
    const restored = local.makeStore()
    await restored.getState().ensureSession()
    expect(restored.getState().session).toMatchObject({ draft: '底部草稿', remote: { sessionId: 'server-session' } })
    expect(restored.getState().session?.editing).toBeUndefined()
  })

  it('附件超限的明确拒绝清除 pending，允许按新限制重新准备', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    store.getState().setDraft('消息')
    backend.api.createTask.mockRejectedValueOnce(new AgentHttpError('单张图片不能超过 1 MiB。', 'attachment-too-large', 400))
    expect(await store.getState().send(backend.api, chatTestModel)).toBe(false)
    expect(store.getState().session?.pending).toBeUndefined()
    expect(notificationMessage()).toBe('单张图片不能超过 1 MiB。')
  })

  it('上传和本地保存完成前阻止发送与重叠选图，完成后附图发送', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    const upload = backend.api.uploadAttachments.getMockImplementation()!
    const uploaded = deferred<Awaited<ReturnType<typeof upload>>>()
    const saving = deferred<void>()
    const savingStarted = deferred<void>()
    const attach = local.adapter.attach
    vi.spyOn(local.adapter, 'attach').mockImplementation(async files => {
      savingStarted.resolve()
      await saving.promise
      return attach(files)
    })
    backend.api.uploadAttachments.mockReturnValueOnce(uploaded.promise)
    await store.getState().ensureSession()
    store.getState().setDraft('分析图片')
    const file = new File(['png'], 'diagram.png', { type: 'image/png' })
    const adding = store.getState().addAttachments(backend.api, [file])
    expect(store.getState().uploadingAttachments).toBe(true)
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(false)
    await store.getState().addAttachments(backend.api, [file])
    await vi.waitFor(() => expect(backend.api.uploadAttachments).toHaveBeenCalledOnce())
    expect(backend.api.createSession).not.toHaveBeenCalled()
    expect(backend.api.createTask).not.toHaveBeenCalled()
    expect(store.getState().session?.pending).toBeUndefined()

    uploaded.resolve(await upload([file]))
    await savingStarted.promise
    expect(store.getState().uploadingAttachments).toBe(true)
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(false)
    store.getState().setDraft('继续分析图片')
    saving.resolve()
    await adding
    expect(store.getState().uploadingAttachments).toBe(false)
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(true)
    expect(backend.api.createTask).toHaveBeenCalledWith('server-session', expect.objectContaining({
      content: '继续分析图片', attachments: [{ id: 'server-attachment-1' }],
    }))
  })

  it('上传失败解除锁定，保留草稿并允许重新添加', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    const uploaded = deferred<Awaited<ReturnType<typeof backend.api.uploadAttachments>>>()
    backend.api.uploadAttachments.mockReturnValueOnce(uploaded.promise)
    await store.getState().ensureSession()
    store.getState().setDraft('分析图片')
    const file = new File(['png'], 'diagram.png', { type: 'image/png' })
    const adding = store.getState().addAttachments(backend.api, [file])
    await vi.waitFor(() => expect(backend.api.uploadAttachments).toHaveBeenCalledOnce())
    uploaded.reject(new Error('上传失败'))
    await adding
    expect(store.getState().uploadingAttachments).toBe(false)
    expect(notificationMessage()).toBe('上传失败')
    expect(store.getState().session?.draft).toBe('分析图片')
    expect(store.getState().session?.attachments).toEqual([])
    await store.getState().addAttachments(backend.api, [file])
    expect(store.getState().session?.attachments).toHaveLength(1)
    expect(store.getState().uploadingAttachments).toBe(false)
  })

  it('本地保存失败也解除上传锁定并显示错误', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    vi.spyOn(local.adapter, 'attach').mockRejectedValueOnce(new Error('本地保存失败'))
    await store.getState().addAttachments(backend.api, [new File(['png'], 'diagram.png', { type: 'image/png' })])
    expect(store.getState().uploadingAttachments).toBe(false)
    expect(notificationMessage()).toBe('本地保存失败')
    expect(store.getState().session?.attachments).toEqual([])
  })

  it.each(['切换会话', '新建会话', '重新登录'] as const)('%s后旧上传不回灌，也不会解除新上传的锁定', async navigation => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    const upload = backend.api.uploadAttachments.getMockImplementation()!
    const oldUpload = deferred<Awaited<ReturnType<typeof upload>>>()
    const newUpload = deferred<Awaited<ReturnType<typeof upload>>>()
    backend.api.uploadAttachments.mockReturnValueOnce(oldUpload.promise).mockReturnValueOnce(newUpload.promise)
    const attach = vi.spyOn(local.adapter, 'attach')
    await store.getState().ensureSession()
    const oldFile = new File(['old'], 'old.png', { type: 'image/png' })
    const oldAdding = store.getState().addAttachments(backend.api, [oldFile])
    await vi.waitFor(() => expect(backend.api.uploadAttachments).toHaveBeenCalledOnce())

    if (navigation === '切换会话') await store.getState().selectSession(backend.api, backend.session.id)
    else if (navigation === '新建会话') await store.getState().newSession()
    else { store.getState().clearDisplay(); await store.getState().ensureSession() }
    expect(store.getState().uploadingAttachments).toBe(false)
    const newFile = new File(['new'], 'new.png', { type: 'image/png' })
    const newAdding = store.getState().addAttachments(backend.api, [newFile])
    await vi.waitFor(() => expect(backend.api.uploadAttachments).toHaveBeenCalledTimes(2))

    oldUpload.resolve(await upload([oldFile]))
    await oldAdding
    expect(attach).not.toHaveBeenCalled()
    expect(store.getState().session?.attachments).toEqual([])
    expect(store.getState().uploadingAttachments).toBe(true)
    newUpload.resolve(await upload([newFile]))
    await newAdding
    expect(store.getState().uploadingAttachments).toBe(false)
    expect(store.getState().session?.attachments.map(attachment => attachment.name)).toEqual(['new.png'])
    expect(local.files.size).toBe(1)
  })

  it('图片处理期间阻止发送和模型切换，离开会话后中止处理且不再上传', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    const prepared = deferred<File>()
    vi.mocked(prepareAgentImage).mockReturnValueOnce(prepared.promise)
    await store.getState().ensureSession()
    store.getState().setModel('old-model')
    store.getState().setDraft('分析图片')
    const file = new File(['png'], 'diagram.png', { type: 'image/png' })
    const adding = store.getState().addAttachments(backend.api, [file])
    await vi.waitFor(() => expect(prepareAgentImage).toHaveBeenCalledOnce())
    const signal = vi.mocked(prepareAgentImage).mock.calls[0]![1]!
    expect(store.getState().uploadingAttachments).toBe(true)
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(false)
    store.getState().setModel('new-model')
    expect(store.getState().session?.modelId).toBe('old-model')
    await store.getState().newSession()
    expect(signal.aborted).toBe(true)
    prepared.resolve(file)
    await adding
    expect(backend.api.uploadAttachments).not.toHaveBeenCalled()
    expect(store.getState().uploadingAttachments).toBe(false)
  })

  it('格式与处理失败在上传前拒绝，失败文件不进会话', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    await store.getState().addAttachments(backend.api, [new File(['x'], 'a.txt', { type: 'text/plain' })])
    expect(notificationMessage()).toContain('图片仅支持 JPEG 与 PNG')
    vi.mocked(prepareAgentImage).mockRejectedValueOnce(new Error('无法读取图片“big.png”，请重新选择。'))
    await store.getState().addAttachments(backend.api, [new File([new ArrayBuffer(4194305)], 'big.png', { type: 'image/png' })])
    expect(notificationMessage()).toContain('big.png')
    expect(backend.api.uploadAttachments).not.toHaveBeenCalled()
    expect(store.getState().session?.attachments).toEqual([])
    expect(store.getState().uploadingAttachments).toBe(false)
  })

  it('会话存储连续失败只提示一次，成功写入后再次失败开启新的提示周期', async () => {
    const local = localMemory()
    const store = local.makeStore()
    await store.getState().ensureSession()
    const originalWrite = local.adapter.write
    const write = vi.spyOn(local.adapter, 'write').mockReturnValue(false)
    store.getState().setDraft('第一次输入')
    store.getState().setDraft('第二次输入')
    store.getState().setModel(chatTestModel.id)
    expect(useNotificationStore.getState().notifications).toEqual([
      expect.objectContaining({ tone: 'info', message: '浏览器暂时无法保存会话，刷新后可能丢失本页内容。' }),
    ])
    expect(store.getState().session?.draft).toBe('第二次输入')
    write.mockImplementation(originalWrite)
    store.getState().setDraft('存储恢复')
    write.mockReturnValue(false)
    store.getState().setDraft('再次失败')
    expect(useNotificationStore.getState().notifications).toHaveLength(2)
    expect(notificationMessage()).toBe('浏览器暂时无法保存会话，刷新后可能丢失本页内容。')
  })

  it('手动重试保存发送标识失败会再次提示，通用存储警告仍按故障周期去重', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    store.getState().setDraft('保留待发送消息')
    vi.spyOn(local.adapter, 'write').mockReturnValue(false)
    expect(await store.getState().send(backend.api, chatTestModel)).toBe(false)
    expect(await store.getState().send(backend.api, chatTestModel)).toBe(false)
    const notifications = useNotificationStore.getState().notifications
    expect(notifications.filter(item => item.message === '浏览器暂时无法保存会话，刷新后可能丢失本页内容。')).toHaveLength(1)
    expect(notifications.filter(item => item.message === '无法保存发送标识，请恢复浏览器存储后再发送。')).toHaveLength(2)
    expect(backend.api.createTask).not.toHaveBeenCalled()
    expect(store.getState().session?.draft).toBe('保留待发送消息')
    expect(store.getState().session?.pending).toBeUndefined()
  })

  it('附件持久化连续失败只提示一次，成功保存后再次失败重新提示', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    const originalAttach = local.adapter.attach
    let persisted = false
    vi.spyOn(local.adapter, 'attach').mockImplementation(async files => ({ ...await originalAttach(files), persisted }))
    const add = (index: number) => store.getState().addAttachments(backend.api, [new File(['x'], `${index}.png`, { type: 'image/png' })])
    await add(1)
    await add(2)
    expect(useNotificationStore.getState().notifications).toEqual([
      expect.objectContaining({ tone: 'info', message: '附件仅在当前页面可用，浏览器暂时无法保存文件；刷新后请重新选择。' }),
    ])
    persisted = true
    await add(3)
    persisted = false
    await add(4)
    expect(useNotificationStore.getState().notifications).toHaveLength(2)
    expect(store.getState().session?.attachments).toHaveLength(4)
  })

  it('恢复相同缺失附件集合时不重复提示，缺失集合变化后再次提示', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    await store.getState().addAttachments(backend.api, [new File(['x'], 'missing.png', { type: 'image/png' })])
    local.files.clear()
    store.getState().clearDisplay()
    await store.getState().ensureSession()
    expect(useNotificationStore.getState().notifications).toHaveLength(1)
    expect(notificationMessage()).toContain('无法从浏览器恢复')
    local.publish()
    await Promise.resolve()
    local.publish()
    await Promise.resolve()
    expect(useNotificationStore.getState().notifications).toHaveLength(1)
    const saved = local.adapter.read()!
    local.adapter.write({ ...saved, attachments: [...saved.attachments, {
      id: 'missing-2', serverId: 'server-2', name: 'second.png', size: 1, type: 'image/png', lastModified: 0, available: true,
    }] })
    local.publish()
    await Promise.resolve()
    expect(useNotificationStore.getState().notifications).toHaveLength(2)
    local.publish()
    await Promise.resolve()
    expect(useNotificationStore.getState().notifications).toHaveLength(2)
  })

  it('clearDisplay 只清 Ely 自己的消息，迟到压缩错误不污染重新登录的展示', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    const externalId = useNotificationStore.getState().notify({ tone: 'success', message: '其他页面的操作反馈' })
    store.getState().reportOperation('Ely 旧操作失败')
    const preparation = deferred<File>()
    vi.mocked(prepareAgentImage).mockReturnValueOnce(preparation.promise)
    const adding = store.getState().addAttachments(backend.api, [new File(['x'], 'old.png', { type: 'image/png' })])
    await vi.waitFor(() => expect(prepareAgentImage).toHaveBeenCalledOnce())
    const signal = vi.mocked(prepareAgentImage).mock.calls[0]![1]!
    store.getState().clearDisplay()
    expect(signal.aborted).toBe(true)
    expect(useNotificationStore.getState().notifications).toEqual([
      { id: externalId, tone: 'success', message: '其他页面的操作反馈' },
    ])
    await store.getState().ensureSession()
    store.getState().reportOperation('Ely 新操作反馈', 'info')
    preparation.reject(new Error('旧图片压缩失败'))
    await adding
    expect(useNotificationStore.getState().notifications.map(item => item.message)).toEqual(['其他页面的操作反馈', 'Ely 新操作反馈'])
    expect(store.getState().session?.attachments).toEqual([])
    expect(store.getState().uploadingAttachments).toBe(false)
    expect(backend.api.uploadAttachments).not.toHaveBeenCalled()
  })

  it('无图能力模型的会话拒绝带附件发送并提示切换', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    await store.getState().addAttachments(backend.api, [new File(['image'], 'diagram.png', { type: 'image/png' })])
    store.getState().setDraft('分析图片')
    expect(await store.getState().send(backend.api, chatTestModel)).toBe(false)
    expect(backend.api.createTask).not.toHaveBeenCalled()
    expect(notificationMessage()).toBe('当前模型不支持图片输入，请移除附件或切换支持图片的模型。')
  })

  it('回执丢失后 pending 保留附件引用，重试按原输入复用同一批 id', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    await store.getState().addAttachments(backend.api, [new File(['image'], 'diagram.png', { type: 'image/png' })])
    store.getState().setDraft('分析图片')
    const submit = backend.api.createTask.getMockImplementation()!
    backend.api.createTask.mockImplementationOnce(async (...args) => { await submit(...args as Parameters<typeof submit>); throw new AgentHttpError('请求失败', 'attachment-invalid', 400) })
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(false)
    expect(store.getState().session?.pending).toBeUndefined()
    backend.api.createTask.mockImplementationOnce(async (...args) => { await submit(...args as Parameters<typeof submit>); throw new Error('回执丢失') })
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(false)
    expect(store.getState().session?.pending?.input.attachments).toEqual([{ id: 'server-attachment-1' }])
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(true)
    expect(backend.api.createTask).toHaveBeenLastCalledWith('server-session', expect.objectContaining({
      attachments: [{ id: 'server-attachment-1' }],
    }))
  })

  it('编辑重发携带原轮附件 id，当前模型无图能力时拒绝且不写 pending', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    await store.getState().addAttachments(backend.api, [new File(['image'], 'diagram.png', { type: 'image/png' })])
    store.getState().setDraft('带图第一轮')
    await store.getState().send(backend.api, chatVisionTestModel)
    await store.getState().refresh(backend.api)
    store.getState().editMessage('message-1')
    expect(store.getState().session?.editing?.attachments).toEqual([{ id: 'server-attachment-1' }])
    store.getState().setEditText('改写后的问题')
    // 编辑中途切换到无图模型：send 拦截且不写 pending（覆盖入口预挡的时序缝隙）。
    expect(await store.getState().send(backend.api, chatTestModel)).toBe(false)
    expect(store.getState().session?.pending).toBeUndefined()
    expect(notificationMessage()).toBe('当前模型不支持图片输入，无法重发带图消息，请切换支持图片的模型。')
    // 切回有图模型后重发沿用原轮附件 id。
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(true)
    expect(backend.api.continueTask).toHaveBeenLastCalledWith('task-1', expect.objectContaining({
      content: '改写后的问题', replaceMessageId: 'message-1', attachments: [{ id: 'server-attachment-1' }],
    }))
    expect(store.getState().session?.editing).toBeUndefined()
  })

  it('编辑期间不能添加草稿附件，原轮无附件的编辑重发绝不捎带草稿附件', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    store.getState().setDraft('纯文本第一轮')
    await store.getState().send(backend.api, chatVisionTestModel)
    await store.getState().refresh(backend.api)
    // 先落草稿附件（编辑开始前添加仍允许），再进入编辑：编辑只改文本。
    await store.getState().addAttachments(backend.api, [new File(['image'], 'draft.png', { type: 'image/png' })])
    store.getState().editMessage('message-1')
    expect(store.getState().session?.editing?.attachments).toBeUndefined()
    await store.getState().addAttachments(backend.api, [new File(['image'], 'another.png', { type: 'image/png' })])
    expect(notificationMessage()).toBe('正在编辑消息，完成后才能添加附件。')
    expect(store.getState().session?.attachments).toHaveLength(1)
    store.getState().setEditText('改写纯文本')
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(true)
    const input = backend.api.continueTask.mock.lastCall?.[1]
    expect(input).not.toHaveProperty('attachments')
    // 草稿附件不被编辑重发消耗，仍留在草稿。
    expect(store.getState().session?.attachments.map(attachment => attachment.name)).toEqual(['draft.png'])
  })

  it.each([false, true])('编辑重发不受底部未上传旧附件阻挡，原轮含图片：%s', async originalHasImage => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    const model = originalHasImage ? chatVisionTestModel : chatTestModel
    await store.getState().ensureSession()
    if (originalHasImage) await store.getState().addAttachments(backend.api, [new File(['original'], 'original.png', { type: 'image/png' })])
    store.getState().setDraft('原消息')
    expect(await store.getState().send(backend.api, model)).toBe(true)
    const legacy = await local.adapter.attach([new File(['legacy'], 'legacy.png', { type: 'image/png' })])
    store.getState().session!.attachments = legacy.attachments
    store.getState().setDraft('底部独立草稿')
    store.getState().editMessage('message-1')
    store.getState().setEditText('改写原消息')
    backend.api.uploadAttachments.mockClear()
    vi.mocked(prepareAgentImage).mockClear()
    expect(await store.getState().send(backend.api, model)).toBe(true)
    const input = backend.api.continueTask.mock.lastCall?.[1]
    expect(input).toMatchObject({ content: '改写原消息', replaceMessageId: 'message-1' })
    if (originalHasImage) expect(input?.attachments).toEqual([{ id: 'server-attachment-1' }])
    else expect(input).not.toHaveProperty('attachments')
    expect(store.getState().session?.attachments).toEqual(legacy.attachments)
    expect(store.getState().session?.draft).toBe('底部独立草稿')
    expect(local.files.has(legacy.attachments[0]!.id)).toBe(true)
    expect(backend.api.uploadAttachments).not.toHaveBeenCalled()
    expect(prepareAgentImage).not.toHaveBeenCalled()
    expect(useNotificationStore.getState().notifications).toEqual([])
  })

  it('重试成功只清本次发送引用的附件，窗口内新增的草稿附件保留', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    await store.getState().ensureSession()
    await store.getState().addAttachments(backend.api, [
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' }),
    ])
    store.getState().setDraft('带图消息')
    const submit = backend.api.createTask.getMockImplementation()!
    backend.api.createTask.mockImplementationOnce(async (...args) => { await submit(...args as Parameters<typeof submit>); throw new Error('回执丢失') })
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(false)
    expect(store.getState().session?.pending).toBeDefined()
    // 模拟未确认窗口内另一标签向同会话新增的第三张草稿附件（含本地字节）。
    const other = local.makeStore()
    await other.getState().ensureSession()
    await other.getState().addAttachments(backend.api, [new File(['c'], 'c.png', { type: 'image/png' })])
    local.publish()
    await Promise.resolve()
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(true)
    // 仅本次发送的 a/b 被清掉并释放字节，新增的 c 保留在草稿且本地字节未被动过。
    expect(store.getState().session?.attachments.map(attachment => attachment.name)).toEqual(['c.png'])
    const kept = store.getState().session?.attachments[0]
    expect(kept?.serverId).toBe('server-attachment-3')
    expect(local.files.has(kept?.id ?? '')).toBe(true)
  })

  it('刷新后文件字节丢失时明确标记，仍可凭服务端引用发送', async () => {
    const local = localMemory()
    const first = local.makeStore()
    const backend = chatTestApi()
    await first.getState().ensureSession()
    await first.getState().addAttachments(backend.api, [new File(['png'], 'a.png', { type: 'image/png' })])
    first.getState().setDraft('分析图片')
    local.files.clear()
    const restored = local.makeStore()
    await restored.getState().ensureSession()
    expect(restored.getState().session?.attachments[0]?.available).toBe(false)
    expect(restored.getState().session?.attachments[0]?.serverId).toBe('server-attachment-1')
    expect(notificationMessage()).toContain('无法从浏览器恢复')
    expect(await restored.getState().send(backend.api, chatVisionTestModel)).toBe(true)
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
    const backend = chatTestApi()
    await store.getState().ensureSession()
    const pending = store.getState().addAttachments(backend.api, [new File(['png'], 'a.png', { type: 'image/png' })])
    await started
    await store.getState().newSession()
    finish()
    await pending
    expect(store.getState().session?.attachments).toEqual([])
    expect(local.files.size).toBe(0)
  })
})

describe('基本聊天', () => {
  it('收尾阶段可保存下一轮偏好，但仍等待本轮终态才接受发送', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    backend.hold()
    await store.getState().ensureSession()
    store.getState().setModel(chatTestModel.id)
    store.getState().setReasoningLevel('high')
    store.getState().setDraft('请回答')
    await store.getState().send(backend.api, chatTestModel)
    store.getState().setModel(chatVisionTestModel.id)
    store.getState().setReasoningLevel('low')
    store.getState().setPermissionMode('assist')
    expect(store.getState().session).toMatchObject({ modelId: chatTestModel.id, reasoningLevel: 'high', permissionMode: 'ask' })

    backend.runs.get('run-1')!.phase = 'final-memory'
    await store.getState().refresh(backend.api)
    store.getState().setModel(chatVisionTestModel.id)
    store.getState().setReasoningLevel('low')
    store.getState().setPermissionMode('assist')
    store.getState().setDraft('下一轮')
    expect(store.getState().session).toMatchObject({ modelId: chatVisionTestModel.id, reasoningLevel: 'low', permissionMode: 'assist' })
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(false)
    expect(backend.api.switchModel).not.toHaveBeenCalled()
    expect(store.getState().run).toMatchObject({ status: 'running', phase: 'final-memory' })

    backend.complete()
    await store.getState().refresh(backend.api)
    expect(await store.getState().send(backend.api, chatVisionTestModel)).toBe(true)
    expect(backend.api.continueTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ content: '下一轮', reasoningLevel: 'low' }))
  })

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
    expect(notificationMessage()).toBe('模型不可用')
    expect(store.getState().session?.draft).toBe('你好')
    expect(store.getState().messages).toEqual([])
    expect(store.getState().session?.pending).toBeUndefined()
  })

  it('同会话第二轮发送期间，第一轮迟到的思考读取不能解除发送锁或刷新列表', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    const firstReasoning = deferred<string>()
    backend.api.reasoning.mockReturnValueOnce(firstReasoning.promise)
    await store.getState().ensureSession()
    store.getState().setDraft('第一轮')
    const firstSending = store.getState().send(backend.api, chatTestModel)
    await vi.waitFor(() => expect(backend.api.reasoning).toHaveBeenCalledOnce())
    expect(store.getState().run?.status).toBe('succeeded')
    expect(store.getState().sending).toBe(false)
    expect(store.getState().session?.pending).toBeUndefined()
    const secondReading = deferred<AgentSession>()
    backend.api.getSession.mockReturnValueOnce(secondReading.promise)
    store.getState().setDraft('第二轮')
    const secondSending = store.getState().send(backend.api, chatTestModel)
    await vi.waitFor(() => expect(backend.api.getSession).toHaveBeenCalledTimes(2))
    expect(store.getState().sending).toBe(true)
    firstReasoning.resolve('第一轮迟到的思考')
    expect(await firstSending).toBe(false)
    expect(store.getState().sending).toBe(true)
    expect(store.getState().reasoning).toEqual({})
    expect(backend.api.listSessions).not.toHaveBeenCalled()
    expect(await store.getState().send(backend.api, chatTestModel)).toBe(false)
    expect(backend.api.continueTask).not.toHaveBeenCalled()
    secondReading.resolve({ ...backend.session })
    expect(await secondSending).toBe(true)
    expect(store.getState().sending).toBe(false)
    expect(backend.api.continueTask).toHaveBeenCalledExactlyOnceWith('task-1', expect.objectContaining({ content: '第二轮' }))
    expect(backend.api.listSessions).toHaveBeenCalledOnce()
    expect(store.getState().messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['第一轮', '第二轮'])
    expect(useNotificationStore.getState().notifications).toEqual([])
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
    expect(notificationMessage()).toContain('发送结果尚未确认')
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
    expect(notificationMessage()).toBe('业务条件不满足')
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
    await vi.waitFor(() => expect(resolve).toBeDefined())
    store.getState().clearDisplay()
    await store.getState().ensureSession()
    resolve(session)
    await sending
    expect(store.getState().session?.remote).toBeUndefined()
    expect(store.getState().messages).toEqual([])
    expect(api.createTask).not.toHaveBeenCalled()
  })

  it('POST 已确认后的回读期间登出，旧回读结束不再刷新列表或发送消息', async () => {
    const local = localMemory()
    const store = local.makeStore()
    const backend = chatTestApi()
    const reading = deferred<AgentSession>()
    backend.api.getSession.mockReturnValueOnce(reading.promise)
    await store.getState().ensureSession()
    store.getState().setDraft('已被接受的消息')
    const sending = store.getState().send(backend.api, chatTestModel)
    await vi.waitFor(() => expect(backend.api.getSession).toHaveBeenCalledOnce())
    expect(backend.api.createTask).toHaveBeenCalledOnce()
    expect(store.getState().session?.pending).toBeUndefined()
    expect(store.getState().run?.id).toBe('run-1')
    store.getState().clearDisplay()
    reading.resolve({ ...backend.session })
    expect(await sending).toBe(false)
    expect(backend.api.listSessions).not.toHaveBeenCalled()
    expect(backend.api.messages).not.toHaveBeenCalled()
    expect(useNotificationStore.getState().notifications).toEqual([])
    expect(store.getState().session).toBeNull()
    expect(store.getState().messages).toEqual([])
    expect(store.getState().sessions).toEqual([])
    expect(local.adapter.read(backend.session.id)?.remote?.runId).toBe('run-1')
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

  it('静默会话列表读取失败保留页面状态而不弹消息，手动刷新失败才提示', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    backend.api.listSessions.mockResolvedValueOnce({ items: [backend.session], nextCursor: '', hasMore: false })
    await store.getState().loadSessions(backend.api)
    backend.api.listSessions.mockRejectedValue(new Error('会话列表连接失败'))
    await store.getState().loadSessions(backend.api, false, true)
    expect(useNotificationStore.getState().notifications).toEqual([])
    expect(store.getState().listError).toBe('会话列表连接失败')
    expect(store.getState().sessions).toEqual([backend.session])
    await store.getState().loadSessions(backend.api, false, false, true)
    expect(notificationMessage()).toBe('会话列表连接失败')
    expect(store.getState().listError).toBeNull()
    expect(store.getState().sessions).toEqual([backend.session])
    expect(store.getState().listLoading).toBe(false)
  })

  it('手动首次读取失败同时提供消息与页面重试状态', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    backend.api.listSessions.mockRejectedValueOnce(new Error('首次连接失败'))
    await store.getState().loadSessions(backend.api, false, false, true)
    expect(notificationMessage()).toBe('首次连接失败')
    expect(store.getState().listError).toBe('首次连接失败')
    expect(store.getState().listLoading).toBe(false)
  })

  it('退出登录后旧会话列表失败不会新增消息或恢复页面错误', async () => {
    const store = localMemory().makeStore()
    const backend = chatTestApi()
    const page = deferred<Awaited<ReturnType<typeof backend.api.listSessions>>>()
    backend.api.listSessions.mockReturnValueOnce(page.promise)
    const loading = store.getState().loadSessions(backend.api, false, false, true)
    store.getState().clearDisplay()
    page.reject(new Error('旧列表请求失败'))
    await loading
    expect(useNotificationStore.getState().notifications).toEqual([])
    expect(store.getState().listError).toBeNull()
    expect(store.getState().listLoading).toBe(false)
    expect(store.getState().session).toBeNull()
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
    await store.getState().addAttachments(backend.api, [new File(['png'], 'a.png', { type: 'image/png' })])
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
    expect(notificationMessage()).toContain('原会话已不存在')
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
    expect(notificationMessage()).toContain('原会话已不存在')
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
    expect(useNotificationStore.getState().notifications).toEqual([])
    expect(store.getState().listCursor).toBe('cursor-1')
    expect(store.getState().listHasMore).toBe(true)
    expect(local.adapter.read('session-b')).toBeNull()
    expect(local.files.size).toBe(0)
  })

  it('删除当前选中会话回落到剩余第一个会话并以消息说明去向', async () => {
    const { store, backend } = await preparedStore()
    expect(store.getState().remoteSession?.id).toBe('session-a')
    await store.getState().deleteSession(backend.api, 'session-a')
    expect(store.getState().sessions.map(row => row.id)).toEqual(['session-b'])
    expect(store.getState().remoteSession?.id).toBe('session-b')
    expect(notificationMessage()).toBe('会话已删除，已切换到其他会话。')
  })

  it('删除最后一个会话回落到空白草稿并以消息说明去向', async () => {
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
    expect(notificationMessage()).toBe('会话已删除，已新建空白会话。')
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
