import { afterEach, describe, expect, it, vi } from 'vitest'
import fixture from '../../../../../../packages/foundation/contracts/fixtures/agent-session.json'
import timelineFixture from '../../../../../../packages/foundation/contracts/fixtures/agent-chat-timeline.json'
import { createHttpAgentConversationAdapter, createUnavailableAgentConversationAdapter } from './agentConversationHttpAdapter'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const attachment = (index: number) => ({ id: `attach-${index}`, name: `${index}.png`, mimeType: 'image/png', bytes: 1, width: 1, height: 1 })
const images = (count: number) => Array.from({ length: count }, (_, index) => new File(['x'], `${index}.png`, { type: 'image/png' }))

describe('聊天 HTTP 接口', () => {
  it('缺少 AbortSignal.any 与 timeout 时仍能接收输出且完成后不遗留计时器', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('AbortSignal', {})
    const output = { runId: 'r1', responseId: 'm1', reasoning: '推理', content: '中文输出', done: true }
    const fetcher = vi.fn().mockResolvedValue(new Response(`event: output\ndata: ${JSON.stringify(output)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetcher)
    const seen = vi.fn()
    await createHttpAgentConversationAdapter().stream('r1', seen, new AbortController().signal)
    expect(seen).toHaveBeenCalledExactlyOnceWith(output)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('输出流正文阻塞时仍遵守 45 秒上限并关闭读取，不重发写请求', async () => {
    vi.useFakeTimers()
    const cancelled = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled })
    let bounded: AbortSignal | undefined
    const fetcher = vi.fn(async (_url, init: RequestInit) => { bounded = init.signal ?? undefined; return new Response(body, { headers: { 'content-type': 'text/event-stream' } }) })
    vi.stubGlobal('fetch', fetcher)
    const result = expect(createHttpAgentConversationAdapter().stream('r1', vi.fn(), new AbortController().signal)).rejects.toMatchObject({ name: 'RequestTimeoutError', uncertain: false })
    await vi.advanceTimersByTimeAsync(45000)
    await result
    expect(bounded?.aborted).toBe(true)
    expect(cancelled).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('外部取消立即关闭正在读取的输出流', async () => {
    const cancelled = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } })))
    const controller = new AbortController()
    const task = createHttpAgentConversationAdapter().stream('r1', vi.fn(), controller.signal)
    const result = expect(task).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve(); await Promise.resolve()
    controller.abort()
    await result
    expect(cancelled).toHaveBeenCalledOnce()
  })
  it('在连接结束前交付增量，支持跨分片中文，终帧关闭读取且不提交模型请求', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetcher)
    const seen = vi.fn()
    const task = createHttpAgentConversationAdapter().stream('r1', seen, new AbortController().signal)
    const output = { runId: 'r1', responseId: 'm1', reasoning: '正在分析', content: '第一段', done: false }
    const bytes = new TextEncoder().encode(`event: output\ndata: ${JSON.stringify(output)}\n\n`)
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith(output))
    controller.enqueue(new TextEncoder().encode(`event: output\ndata: ${JSON.stringify({ ...output, content: '完整回答', done: true })}\n\n`))
    await task
    expect(seen).toHaveBeenLastCalledWith({ ...output, content: '完整回答', done: true })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]![0]).toBe('/api/agent/runs/r1/output')
  })

  it('按页读取实际思考，跳过整理过程与调试字段，已确认文本优先于生成中快照', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ items: [
        { runId: 'r1', purpose: 'inference', reasoning: '生成中的第一行' },
        { runId: 'r1', purpose: 'checkpoint', reasoning: '不展示整理内容' },
      ], nextCursor: '2', hasMore: true }))
      .mockResolvedValueOnce(json({ items: [
        { runId: 'r1', purpose: 'inference', reasoning: '旧快照', response: { reasoning: '已确认的第二行', content: '最终答复' } },
        { runId: 'r1', purpose: 'inference', response: { content: '普通答复', debug: '不可展示', encrypted_content: '不可展示' } },
      ], hasMore: false }))
    vi.stubGlobal('fetch', fetcher)
    expect(await createHttpAgentConversationAdapter().reasoning('r1')).toBe('生成中的第一行\n\n已确认的第二行')
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/api/agent/runs/r1/model-requests?cursor=0&limit=50', '/api/agent/runs/r1/model-requests?cursor=2&limit=50',
    ])
  })

  it('历史接口与 SSE 使用相同时间线、累计用量、加权缓存与六类上下文估算，保留旧输出字段', async () => {
    const timeline = timelineFixture
    const output = { runId: 'r1', responseId: 'm1', reasoning: '', content: '最终正文', done: true, timeline }
    const fetcher = vi.fn().mockResolvedValueOnce(json(timeline)).mockResolvedValueOnce(new Response(`event: output\ndata: ${JSON.stringify(output)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetcher)
    const api = createHttpAgentConversationAdapter()
    expect(await api.timeline('r1')).toEqual(timeline)
    const seen = vi.fn()
    await api.stream('r1', seen, new AbortController().signal)
    expect(seen).toHaveBeenCalledExactlyOnceWith(output)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/agent/runs/r1/timeline', '/api/agent/runs/r1/output'])
  })

  it('HTTP 与 SSE 兼容旧快照，并保留缓存与六类估算的明确零', async () => {
    const { cacheHitUsage: _cache, contextUsage: _context, ...legacy } = timelineFixture
    const timelines = [legacy, { ...legacy, cacheHitUsage: { inputTokens: 0, cachedTokens: 0 },
      contextUsage: { modelRequestId: 'm1', model: 'fixed-model', contextTokens: 65536,
        estimatedBreakdown: { messages: 0, systemTools: 0, other: 0, skills: 0, systemPrompt: 0, mcpTools: 0 } } }]
    for (const timeline of timelines) {
      const output = { runId: 'r1', responseId: 'm1', reasoning: '', content: '最终正文', done: true, timeline }
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(timeline)).mockResolvedValueOnce(new Response(`event: output\ndata: ${JSON.stringify(output)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })))
      const api = createHttpAgentConversationAdapter()
      expect(await api.timeline('r1')).toEqual(timeline)
      const seen = vi.fn()
      await api.stream('r1', seen, new AbortController().signal)
      expect(seen).toHaveBeenCalledExactlyOnceWith(output)
    }
  })

  it.each([
    { modelRequestId: 'm1', model: 'fixed-model', contextTokens: 65536 },
    { modelRequestId: 'm1', model: 'fixed-model', totalTokens: 0, contextTokens: 0 },
  ])('HTTP 与 SSE 保留上下文的未知总量和明确零值 %j', async contextUsage => {
    const timeline = { ...timelineFixture, contextUsage }
    const output = { runId: 'r1', responseId: 'm1', reasoning: '', content: '最终正文', done: true, timeline }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(timeline)).mockResolvedValueOnce(new Response(`event: output\ndata: ${JSON.stringify(output)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })))
    const api = createHttpAgentConversationAdapter()
    expect((await api.timeline('r1')).contextUsage).toEqual(contextUsage)
    const seen = vi.fn()
    await api.stream('r1', seen, new AbortController().signal)
    expect(seen).toHaveBeenCalledExactlyOnceWith(output)
  })

  it('完整时间线与兼容字段超过单次响应容量时仍接收快照', async () => {
    const text = 'x'.repeat(2 * 1024 * 1024 - 512)
    const timeline = { runId: 'r1', status: 'succeeded', done: true, entries: Array.from({ length: 3 }, (_, requestIndex) => ({
      id: `m${requestIndex}:reasoning`, modelRequestId: `m${requestIndex}`, requestIndex, kind: 'reasoning', text, startedAt: '', status: 'succeeded', incomplete: false,
    })) }
    const output = { runId: 'r1', responseId: 'm2', reasoning: [text, text, text].join('\n\n'), content: '', done: true, timeline }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`event: output\ndata: ${JSON.stringify(output)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })))
    const seen = vi.fn()
    await createHttpAgentConversationAdapter().stream('r1', seen, new AbortController().signal)
    expect(seen).toHaveBeenCalledOnce()
    expect(seen.mock.calls[0]![0].timeline.entries).toHaveLength(3)
    expect(seen.mock.calls[0]![0].timeline.entries[0].text.length).toBe(text.length)
  })

  it('按 Calls 分页读取工具结果，保留参数原文与错误和截断标记', async () => {
    const first = { id: 'c1', runId: 'r1', tool: 'tool_a', modelRequestId: 'm1', modelCallId: 't1', status: 'succeeded', stepIndex: 0, argumentsJson: '{"n":9007199254740993}', result: { text: '脱敏后的结果' }, truncated: true }
    const second = { id: 'c2', runId: 'r1', tool: 'tool_b', modelRequestId: 'm1', modelCallId: 't2', status: 'failed', stepIndex: 1, error: { code: 'tool-failed', message: '执行失败' }, truncated: false }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ items: [first], nextCursor: '1', hasMore: true }))
      .mockResolvedValueOnce(json({ items: [second], nextCursor: '', hasMore: false }))
    vi.stubGlobal('fetch', fetcher)
    expect(await createHttpAgentConversationAdapter().calls('r1')).toEqual([{ ...first, args: {} }, { ...second, args: {} }])
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/agent/runs/r1/calls?cursor=0&limit=100', '/api/agent/runs/r1/calls?cursor=1&limit=100'])
  })

  it.each(['重复记录', '游标回退', '串轮记录'])('工具详情拒绝%s且停止分页', async failure => {
    const call = { id: 'c1', runId: 'r1', tool: 'test', status: 'succeeded', stepIndex: 0, truncated: false }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ items: [call], nextCursor: '1', hasMore: true }))
      .mockResolvedValueOnce(json({ items: [{ ...call, id: failure === '重复记录' ? 'c1' : 'c2', runId: failure === '串轮记录' ? 'other' : 'r1' }], nextCursor: '1', hasMore: failure === '游标回退' }))
    vi.stubGlobal('fetch', fetcher)
    await expect(createHttpAgentConversationAdapter().calls('r1')).rejects.toThrow('格式无效')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('创建会话、首轮和续轮复用现有端点，传递文本与思考等级', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(fixture.session, 201)).mockResolvedValueOnce(json(fixture.run, 202)).mockResolvedValueOnce(json(fixture.run, 200))
    vi.stubGlobal('fetch', fetcher)
    const api = createHttpAgentConversationAdapter()
    const input = { ...fixture.input, reasoningLevel: 'high' }
    await api.createSession(fixture.createSession)
    await api.createTask('session-1', input)
    await api.continueTask('task-1', { ...input, replaceMessageId: 'message-1' })
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/agent/sessions', '/api/agent/sessions/session-1/tasks', '/api/agent/tasks/task-1/runs'])
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual(fixture.createSession)
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual(input)
    expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({ ...input, replaceMessageId: 'message-1' })
  })

  it('停止通过现有取消接口读取真实运行状态', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ ...fixture.run, status: 'running', cancelRequestedAt: '2026-10-14T00:00:00Z' }, 202))
    vi.stubGlobal('fetch', fetcher)
    const run = await createHttpAgentConversationAdapter().cancelRun('run-1')
    expect(run.status).toBe('running')
    expect(run.cancelRequestedAt).toBeDefined()
    expect(fetcher).toHaveBeenCalledWith('/api/agent/runs/run-1/cancel', expect.objectContaining({ method: 'POST' }))
  })

  it('消息分页保留大整数游标与隔离标记，拒绝回退游标', async () => {
    const wikiSources = [{ pageId: 'wiki-1', revision: 2, digest: 'fixed-digest' }]
    const message = { ...fixture.message, sessionId: 'session-1', seq: '9007199254740994', quarantined: true, wikiSources }
    const fetcher = vi.fn().mockResolvedValueOnce(json({ items: [message], nextCursor: message.seq, hasMore: true })).mockResolvedValueOnce(json({ items: [], nextCursor: '0', hasMore: true }))
    vi.stubGlobal('fetch', fetcher)
    const api = createHttpAgentConversationAdapter()
    const page = await api.messages('session-1', '9007199254740993')
    expect(page.nextCursor).toBe(message.seq)
    expect(page.items[0]?.quarantined).toBe(true)
    expect(page.items[0]?.wikiSources).toEqual(wikiSources)
    await expect(api.messages('session-1', page.nextCursor)).rejects.toThrow('格式无效')
  })

  it.each([{ revision: 0 }, { revision: 1.5 }, { digest: 12 }])('消息拒绝畸形记忆引用 %j', async malformed => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ items: [{ ...fixture.message, sessionId: 'session-1', seq: '1', wikiSources: [{ pageId: 'wiki-1', revision: 1, digest: 'fixed', ...malformed }] }], nextCursor: '1', hasMore: false })))
    await expect(createHttpAgentConversationAdapter().messages('session-1', '0')).rejects.toThrow('格式无效')
  })

  it('消息分页解析附件描述符，缺字段与畸形附件均按格式无效拒绝', async () => {
    const attachment = { id: 'attach-1', name: '图.png', mimeType: 'image/png', bytes: 71, width: 1, height: 1 }
    const good = { ...fixture.message, sessionId: 'session-1', seq: '1', attachments: [attachment] }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ items: [good], nextCursor: '1', hasMore: false }))
      .mockResolvedValueOnce(json({ items: [{ ...good, seq: '1', attachments: [{ id: 'x', name: 'n' }] }], nextCursor: '1', hasMore: false }))
    vi.stubGlobal('fetch', fetcher)
    const api = createHttpAgentConversationAdapter()
    const page = await api.messages('session-1', '0')
    expect(page.items[0]?.attachments).toEqual([attachment])
    await expect(api.messages('session-1', '0')).rejects.toThrow('格式无效')
  })

  it('附件上传组 multipart 且不设 JSON 头，回读字节校验图片 Content-Type', async () => {
    const upload = vi.fn().mockResolvedValue(json({ items: [
      { id: 'attach-1', name: 'a.png', mimeType: 'image/png', bytes: 2, width: 1, height: 1, createdAt: '2026-10-15T00:00:00Z' },
    ] }, 201))
    const blob = vi.fn().mockResolvedValue(new Response(new Uint8Array([0x89, 0x50]), { status: 200, headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init?: RequestInit) => (url === '/api/agent/attachments' ? upload(url, init) : blob(url, init))))
    const api = createHttpAgentConversationAdapter()
    const file = new File(['png'], 'a.png', { type: 'image/png' })
    const uploaded = await api.uploadAttachments([file])
    expect(uploaded.items[0]).toMatchObject({ id: 'attach-1', name: 'a.png', mimeType: 'image/png', bytes: 2 })
    const [url, init] = upload.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/agent/attachments')
    expect(init.method).toBe('POST')
    const form = init.body as FormData
    expect(form.get('file')).toBeInstanceOf(File)
    expect((form.get('file') as File).name).toBe('a.png')
    expect(new Headers(init.headers).get('content-type')).toBeNull()
    const content = await api.attachmentBlob('attach-1')
    expect(content.type).toBe('image/png')
    expect(blob.mock.calls[0]![0]).toBe('/api/agent/attachments/attach-1')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x', { status: 200, headers: { 'content-type': 'text/plain' } })))
    await expect(api.attachmentBlob('attach-1')).rejects.toThrow('格式无效')
  })

  it('超过 50 张图片时依次单张上传，并按原顺序返回全部回执', async () => {
    let active = 0
    let maximumActive = 0
    const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      const files = (init.body as FormData).getAll('file') as File[]
      expect(files).toHaveLength(1)
      const index = Number(files[0]!.name.replace('.png', ''))
      await Promise.resolve()
      active -= 1
      return json({ items: [attachment(index)] }, 201)
    })
    vi.stubGlobal('fetch', fetcher)
    const result = await createHttpAgentConversationAdapter().uploadAttachments(images(51))
    expect(fetcher).toHaveBeenCalledTimes(51)
    expect(maximumActive).toBe(1)
    expect(result.items.map(item => item.id)).toEqual(Array.from({ length: 51 }, (_, index) => `attach-${index}`))
    expect(fetcher.mock.calls.map(call => ((call[1] as RequestInit).body as FormData).getAll('file').map(file => (file as File).name))).toEqual(
      Array.from({ length: 51 }, (_, index) => [`${index}.png`]),
    )
  })

  it('上传中途失败立即停止，不上传剩余图片或返回部分回执', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ items: [attachment(0)] }, 201))
      .mockResolvedValueOnce(json({ error: '附件超过总量限制', code: 'attachment-limit' }, 413))
    vi.stubGlobal('fetch', fetcher)
    await expect(createHttpAgentConversationAdapter().uploadAttachments(images(3))).rejects.toMatchObject({ message: '附件超过总量限制', status: 413 })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('单张上传回执不是恰好一项时拒绝并停止后续上传', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ items: [attachment(0), attachment(1)] }, 201))
    vi.stubGlobal('fetch', fetcher)
    await expect(createHttpAgentConversationAdapter().uploadAttachments(images(2))).rejects.toThrow('格式无效')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('取消上传会中止当前请求且不再发起后续图片', async () => {
    let currentSignal: AbortSignal | undefined
    const fetcher = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      currentSignal = init.signal ?? undefined
      return new Promise((_, reject) => currentSignal?.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')), { once: true }))
    })
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    const result = createHttpAgentConversationAdapter().uploadAttachments(images(2), controller.signal)
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(currentSignal?.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('预先取消时不发起请求，空文件组无需网络请求', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    controller.abort()
    const api = createHttpAgentConversationAdapter()
    await expect(api.uploadAttachments(images(1), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(await api.uploadAttachments([])).toEqual({ items: [] })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('每张图片独立获得 120 秒时限，整批耗时可超过两分钟', async () => {
    vi.useFakeTimers()
    let index = 0
    const fetcher = vi.fn().mockImplementation(() => new Promise(resolve => {
      const current = index++
      setTimeout(() => resolve(json({ items: [attachment(current)] }, 201)), 90000)
    }))
    vi.stubGlobal('fetch', fetcher)
    const result = createHttpAgentConversationAdapter().uploadAttachments(images(2))
    await vi.advanceTimersByTimeAsync(180000)
    expect((await result).items.map(item => item.id)).toEqual(['attach-0', 'attach-1'])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('单张上传超过 120 秒按写操作超时退出，不重发或继续', async () => {
    vi.useFakeTimers()
    let currentSignal: AbortSignal | undefined
    const fetcher = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      currentSignal = init.signal ?? undefined
      return new Promise(() => {})
    })
    vi.stubGlobal('fetch', fetcher)
    const result = createHttpAgentConversationAdapter().uploadAttachments(images(2))
    const rejected = expect(result).rejects.toMatchObject({ name: 'RequestTimeoutError', uncertain: true })
    await vi.advanceTimersByTimeAsync(120000)
    await rejected
    expect(currentSignal?.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('服务端错误原样显示且不重发请求；演示不请求模型', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ error: '会话忙碌', code: 'session-busy' }, 409))
    vi.stubGlobal('fetch', fetcher)
    await expect(createHttpAgentConversationAdapter().createTask('s', fixture.input)).rejects.toMatchObject({ message: '会话忙碌', status: 409 })
    await expect(createUnavailableAgentConversationAdapter().createSession(fixture.createSession)).rejects.toThrow('本地演示')
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

describe('多会话读取接口', () => {
  it('首页不发送空游标，活动分页透传不透明游标，任务详情恢复最新运行', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ items: [fixture.session], nextCursor: 'opaque-v1', hasMore: true }))
      .mockResolvedValueOnce(json({ items: [], nextCursor: '', hasMore: false }))
      .mockResolvedValueOnce(json({ items: [{ id: 'task-1', sessionId: 'session-1', kind: 'agent' }], nextCursor: '', hasMore: false }))
      .mockResolvedValueOnce(json({ id: 'task-1', sessionId: 'session-1', kind: 'agent', latestRun: { ...fixture.run, sessionId: 'session-1', taskId: 'task-1' } }))
    vi.stubGlobal('fetch', fetcher)
    const api = createHttpAgentConversationAdapter()
    const page = await api.listSessions()
    await api.listSessions(page.nextCursor)
    await api.listTasks('session-1')
    expect((await api.getTask('task-1')).latestRun?.id).toBe(fixture.run.id)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/api/agent/sessions?sort=activity&limit=50', '/api/agent/sessions?sort=activity&limit=50&cursor=opaque-v1',
      '/api/agent/sessions/session-1/tasks?limit=50', '/api/agent/tasks/task-1',
    ])
  })

  it('拒绝任务与运行归属不一致的响应', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ id: 'task-1', sessionId: 'session-1', kind: 'agent', latestRun: { ...fixture.run, taskId: 'other' } })))
    await expect(createHttpAgentConversationAdapter().getTask('task-1')).rejects.toThrow('格式无效')
  })
})
