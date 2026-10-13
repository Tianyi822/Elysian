import { afterEach, describe, expect, it, vi } from 'vitest'
import fixture from '../../../../../../packages/foundation/contracts/fixtures/agent-session.json'
import { createHttpAgentConversationAdapter, createUnavailableAgentConversationAdapter } from './agentConversationHttpAdapter'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
afterEach(() => vi.unstubAllGlobals())

describe('聊天 HTTP 接口', () => {
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

  it('创建会话、首轮和续轮复用现有端点，传递文本与思考等级', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(fixture.session, 201)).mockResolvedValueOnce(json(fixture.run, 202)).mockResolvedValueOnce(json(fixture.run, 200))
    vi.stubGlobal('fetch', fetcher)
    const api = createHttpAgentConversationAdapter()
    const input = { ...fixture.input, reasoningLevel: 'high' }
    await api.createSession(fixture.createSession)
    await api.createTask('session-1', input)
    await api.continueTask('task-1', input)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/agent/sessions', '/api/agent/sessions/session-1/tasks', '/api/agent/tasks/task-1/runs'])
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual(fixture.createSession)
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual(input)
    expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual(input)
  })

  it('消息分页保留大整数游标与隔离标记，拒绝回退游标', async () => {
    const message = { ...fixture.message, sessionId: 'session-1', seq: '9007199254740994', quarantined: true }
    const fetcher = vi.fn().mockResolvedValueOnce(json({ items: [message], nextCursor: message.seq, hasMore: true })).mockResolvedValueOnce(json({ items: [], nextCursor: '0', hasMore: true }))
    vi.stubGlobal('fetch', fetcher)
    const api = createHttpAgentConversationAdapter()
    const page = await api.messages('session-1', '9007199254740993')
    expect(page.nextCursor).toBe(message.seq)
    expect(page.items[0]?.quarantined).toBe(true)
    await expect(api.messages('session-1', page.nextCursor)).rejects.toThrow('格式无效')
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
