import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentHttpError,
  AGENT_REQUEST_ID_PATTERN,
  agentPathPart,
  agentQueryString,
  assertDecimalCursor,
  assertRequestId,
  compareDecimalCursors,
  isAgentGlobalUnavailableError,
  isAgentUnavailableError,
  isDecimalCursor,
  parseAgentPage,
  requestAgentJson,
  sendRawBytes,
} from './agentShared'
import { useAgentRuntimeStore } from '../../../stores/agentRuntimeStore'

afterEach(() => vi.unstubAllGlobals())

describe('十进制字符串游标', () => {
  it('规范游标接受零与无前导零正数，拒绝 +、前导零、空串与非数字', () => {
    expect(isDecimalCursor('0')).toBe(true)
    expect(isDecimalCursor('1')).toBe(true)
    expect(isDecimalCursor('9007199254740993')).toBe(true)
    expect(isDecimalCursor('2')).toBe(true)
    expect(isDecimalCursor('')).toBe(false)
    expect(isDecimalCursor('+1')).toBe(false)
    expect(isDecimalCursor('01')).toBe(false)
    expect(isDecimalCursor('1.0')).toBe(false)
    expect(isDecimalCursor('0x10')).toBe(false)
    expect(isDecimalCursor(' 1')).toBe(false)
    expect(assertDecimalCursor('42', '事件序号')).toBe('42')
    expect(() => assertDecimalCursor('0x1', '事件序号')).toThrow('事件序号必须为规范非负十进制字符串')
  })

  it('比较不经 number：长度先于字典序，2^53 以上数值不丢精度', () => {
    expect(compareDecimalCursors('9', '10')).toBeLessThan(0)
    expect(compareDecimalCursors('10', '9')).toBeGreaterThan(0)
    expect(compareDecimalCursors('9007199254740992', '9007199254740993')).toBeLessThan(0)
    expect(compareDecimalCursors('9007199254740993', '9007199254740992')).toBeGreaterThan(0)
    expect(compareDecimalCursors('123', '123')).toBe(0)
    expect(compareDecimalCursors('007', '7')).toBe(0)
  })
})

describe('requestId 前端预检', () => {
  it('与服务端正则同口径：字母数字开头，仅 . _ : - 续接，长度 1 到 128', () => {
    expect(AGENT_REQUEST_ID_PATTERN.test('abc-123')).toBe(true)
    expect(AGENT_REQUEST_ID_PATTERN.test('A.b:c_d-e')).toBe(true)
    expect(AGENT_REQUEST_ID_PATTERN.test('0')).toBe(true)
    expect(AGENT_REQUEST_ID_PATTERN.test('-abc')).toBe(false)
    expect(AGENT_REQUEST_ID_PATTERN.test('.abc')).toBe(false)
    expect(AGENT_REQUEST_ID_PATTERN.test('abc$')).toBe(false)
    expect(AGENT_REQUEST_ID_PATTERN.test('a'.repeat(128))).toBe(true)
    expect(AGENT_REQUEST_ID_PATTERN.test('a'.repeat(129))).toBe(false)
    expect(() => assertRequestId('好的')).toThrow('requestId 必须以字母或数字开头')
  })
})

describe('Page 信封解析', () => {
  it('三键齐全才有效，逐项校验', () => {
    expect(parseAgentPage({ items: [], nextCursor: '5', hasMore: true }, (item) => {
      if (typeof item !== 'number') throw new Error('项无效')
      return item * 2
    })).toEqual({ items: [], nextCursor: '5', hasMore: true })
    expect(parseAgentPage({ items: [1, 2], nextCursor: '', hasMore: false }, (item) => item as number)).toEqual({
      items: [1, 2], nextCursor: '', hasMore: false,
    })
    expect(() => parseAgentPage({ items: [], hasMore: false }, () => null)).toThrow('Agent 分页响应无效')
    expect(() => parseAgentPage(null, () => null)).toThrow('Agent 分页响应无效')
    expect(() => parseAgentPage({ items: {}, nextCursor: '', hasMore: false }, () => null)).toThrow('Agent 分页响应无效')
  })
})

describe('查询串与路径段编码', () => {
  it('未定义参数不发送，键值逐个编码，空格不裸发', () => {
    expect(agentQueryString({ a: '1', b: undefined, c: 'x y+z' })).toBe('a=1&c=x%20y%2Bz')
    expect(agentQueryString({})).toBe('')
  })

  it('空标识抛中文错误，非空逐段编码', () => {
    expect(agentPathPart('task/1')).toBe('task%2F1')
    expect(() => agentPathPart('', '任务标识')).toThrow('Agent 任务标识不能为空')
  })
})

describe('requestAgentJson', () => {
  it('写请求 Content-Type 恒 application/json，服务端 {error,code} 中文透传并保留 code', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(
      JSON.stringify({ error: '会话正忙，暂不接受新输入', code: 'session-busy' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    await expect(requestAgentJson('/api/agent/sessions/s1/tasks', { method: 'POST', body: '{}' }))
      .rejects.toThrow('会话正忙，暂不接受新输入')
    const init = fetchMock.mock.calls[0]?.[1] as unknown as RequestInit
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    try {
      await requestAgentJson('/api/agent/sessions/s1/tasks', { method: 'POST' })
    } catch (error) {
      expect(isAgentUnavailableError(error)).toBe(false)
      expect((error as AgentHttpError).code).toBe('session-busy')
    }
  })

  it('以 HTTP 状态识别 503，只有内核级故障遮挡全部页面', () => {
    expect(isAgentGlobalUnavailableError(new AgentHttpError('内核不可用', 'unavailable', 503))).toBe(true)
    expect(isAgentGlobalUnavailableError(new AgentHttpError('记录副本故障', 'record-storage-unavailable', 503))).toBe(true)
    for (const code of ['extensions-unavailable', 'mcp-unavailable', 'execution-unavailable', 'resource-rules-unavailable']) {
      const error = new AgentHttpError('分项能力不可用', code, 503)
      expect(isAgentUnavailableError(error)).toBe(true)
      expect(isAgentGlobalUnavailableError(error)).toBe(false)
    }
    expect(isAgentUnavailableError(new AgentHttpError('冲突', 'revision-conflict', 409))).toBe(false)
    expect(isAgentUnavailableError(new AgentHttpError('伪造状态', 'unavailable', 400))).toBe(false)
    expect(isAgentUnavailableError(new Error('unavailable'))).toBe(false)
  })

  it('503 服务端中文 reason 进入全局禁写状态，分项 503 不污染它', async () => {
    useAgentRuntimeStore.getState().reset()
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown) => new Response(
      JSON.stringify({ error: '记录副本尚未恢复', code: 'record-storage-unavailable' }),
      { status: 503 },
    )))
    await expect(requestAgentJson('/api/agent/runs')).rejects.toMatchObject({
      status: 503, code: 'record-storage-unavailable', message: '记录副本尚未恢复',
    })
    expect(useAgentRuntimeStore.getState().unavailableReason).toBe('记录副本尚未恢复')
    useAgentRuntimeStore.getState().reset()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'MCP 通道不可用', code: 'mcp-unavailable' }),
      { status: 503 },
    )))
    await expect(requestAgentJson('/api/agent/mcp-servers')).rejects.toMatchObject({ status: 503 })
    expect(useAgentRuntimeStore.getState().unavailableReason).toBeUndefined()
  })

  it('无 error 体的失败回 HTTP 状态码；成功体原样返回', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
      }
      return new Response('<html>', { status: 500 })
    }))
    await expect(requestAgentJson('/api/agent/x')).resolves.toEqual({ ok: true })
    await expect(requestAgentJson('/api/agent/x', { method: 'POST' })).rejects.toThrow('Agent 请求失败：HTTP 500')
  })
})

describe('sendRawBytes', () => {
  it('绝不设 Content-Type、绝不 JSON 包装：字节原样作为请求体', async () => {
    const fetchMock = vi.fn(async () => new Response('{"revision":3}', { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const bytes = new Uint8Array([123, 34, 97, 34, 58, 57, 48, 48, 55, 49, 57, 57, 50, 53, 52, 55, 52, 48, 57, 57, 51, 125])
    await sendRawBytes('/api/agent/tasks/t1/workspace?path=report.json&expectedRevision=2', 'PUT', bytes)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/agent/tasks/t1/workspace?path=report.json&expectedRevision=2')
    expect(init.method).toBe('PUT')
    expect(init.headers).toBeUndefined()
    expect(init.body).toBe(bytes)
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe('{"a":9007199254740993}')
  })
})
