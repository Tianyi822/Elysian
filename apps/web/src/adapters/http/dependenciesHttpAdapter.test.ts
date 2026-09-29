import { describe, expect, it, vi } from 'vitest'
import {
  createHttpDependenciesAdapter,
  parseDependencyProbe,
  parseDependencyProbeReport,
  sanitizeDependencyText,
} from './dependenciesHttpAdapter'

/*
 * 依赖检测 HTTP adapter 的响应形状校验与请求行为测试：形状漂移必须在 adapter 层
 * 拦下并抛中文错误；fetch 走同源、no-store，非 2xx 透传服务端 error 文案。
 */

const VALID_REPORT = {
  docker: { state: 'ok', detail: null },
  caddy: { state: 'missing', detail: '宿主未提供 Caddy 管理通道' },
}

describe('parseDependencyProbe', () => {
  it('合法结果按字段还原：三值 state 与可空 detail', () => {
    expect(parseDependencyProbe({ state: 'ok', detail: null })).toEqual({ state: 'ok', detail: null })
    expect(parseDependencyProbe({ state: 'missing', detail: 'Docker 未安装或未接通' })).toEqual({
      state: 'missing',
      detail: 'Docker 未安装或未接通',
    })
    expect(parseDependencyProbe({ state: 'error', detail: 'Docker 请求超时' })).toEqual({
      state: 'error',
      detail: 'Docker 请求超时',
    })
  })

  it('非对象与 detail 类型漂移抛中文错误', () => {
    expect(() => parseDependencyProbe(null)).toThrow('依赖检测响应无效')
    expect(() => parseDependencyProbe('ok')).toThrow('依赖检测响应无效')
    expect(() => parseDependencyProbe({ state: 'ok', detail: 42 })).toThrow('依赖检测响应无效')
  })

  it('state 取值非法抛中文错误', () => {
    expect(() => parseDependencyProbe({ state: 'unavailable', detail: null })).toThrow('依赖检测响应状态取值无效')
    expect(() => parseDependencyProbe({ state: 1, detail: null })).toThrow('依赖检测响应状态取值无效')
    expect(() => parseDependencyProbe({ detail: null })).toThrow('依赖检测响应状态取值无效')
  })

  it('detail 超长截断、控制与零宽字符剥离——响应文本不整段进弹窗', () => {
    const long = parseDependencyProbe({ state: 'error', detail: '注'.repeat(500) }).detail
    expect(long?.length).toBe(201)
    expect(long?.endsWith('…')).toBe(true)
    expect(parseDependencyProbe({ state: 'error', detail: 'A\u0000B' }).detail).toBe('A B')
    // 零宽字符剥离成空格后不得拼出与官方文案同形的词（防视觉伪装）。
    expect(parseDependencyProbe({ state: 'error', detail: '重新检\u200b测' }).detail).toBe('重新检 测')
  })
})

describe('sanitizeDependencyText', () => {
  it('控制字符、行分隔、零宽与方向覆盖字符压平为空格', () => {
    expect(sanitizeDependencyText('a\u0000b\u007fc')).toBe('a b c')
    expect(sanitizeDependencyText('a\u2028b\u2029c')).toBe('a b c')
    expect(sanitizeDependencyText('a\u200bb\u200ec')).toBe('a b c')
    expect(sanitizeDependencyText('a\u202ab\u2066c\ufeff')).toBe('a b c ')
  })

  it('超长文本截断到 200 字符并追加省略号，短文本原样保留', () => {
    expect(sanitizeDependencyText('正常文案')).toBe('正常文案')
    const sanitized = sanitizeDependencyText('长'.repeat(300))
    expect(sanitized.length).toBe(201)
    expect(sanitized.startsWith('长'.repeat(200))).toBe(true)
    expect(sanitized.endsWith('…')).toBe(true)
  })
})

describe('parseDependencyProbeReport', () => {
  it('合法报告还原 docker 与 caddy 两份结果', () => {
    expect(parseDependencyProbeReport(VALID_REPORT)).toEqual(VALID_REPORT)
  })

  it('顶层非对象或缺任一依赖字段抛中文错误', () => {
    expect(() => parseDependencyProbeReport(null)).toThrow('依赖检测响应无效')
    expect(() => parseDependencyProbeReport({ docker: { state: 'ok', detail: null } })).toThrow('依赖检测响应无效')
    expect(() => parseDependencyProbeReport({ caddy: { state: 'ok', detail: null } })).toThrow('依赖检测响应无效')
  })

  it('单个依赖形状漂移时逐字拦下，不整批 cast 进 store', () => {
    expect(() => parseDependencyProbeReport({ ...VALID_REPORT, caddy: 'missing' })).toThrow('依赖检测响应无效')
    expect(() =>
      parseDependencyProbeReport({ ...VALID_REPORT, docker: { state: 'broken', detail: null } }),
    ).toThrow('依赖检测响应状态取值无效')
  })
})

describe('createHttpDependenciesAdapter', () => {
  it('probe 落到同源端点并带 no-store', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(VALID_REPORT))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpDependenciesAdapter()
    const report = await adapter.probe()
    expect(fetchMock).toHaveBeenCalledWith('/api/platform/dependencies', { cache: 'no-store' })
    expect(report).toEqual(VALID_REPORT)
    vi.unstubAllGlobals()
  })

  it('自定义 baseUrl 生效', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(VALID_REPORT))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpDependenciesAdapter('/api/platform/dependencies-test')
    await adapter.probe()
    expect(fetchMock).toHaveBeenCalledWith('/api/platform/dependencies-test', { cache: 'no-store' })
    vi.unstubAllGlobals()
  })

  it('HTTP 非 2xx 透传服务端 error 文案', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Docker 服务未就绪：socket 未挂载' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpDependenciesAdapter()
    await expect(adapter.probe()).rejects.toThrow('Docker 服务未就绪：socket 未挂载')
    vi.unstubAllGlobals()
  })

  it('HTTP 非 2xx 且无 error 字段时带状态码的中文错误', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpDependenciesAdapter()
    await expect(adapter.probe()).rejects.toThrow('依赖检测请求失败：HTTP 500')
    vi.unstubAllGlobals()
  })

  it('HTTP 非 2xx 的 error 字段为非字符串时不拼接其内容，回退状态码中文文案', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { inject: '<script>赋值文案' } }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpDependenciesAdapter()
    await expect(adapter.probe()).rejects.toThrow('依赖检测请求失败：HTTP 502')
    vi.unstubAllGlobals()
  })

  it('HTTP 非 2xx 的 error 文案超长或含控制字符时经同一清洗——无约束文本不进通知区', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: `${'注'.repeat(500)}\u0000尾注` }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpDependenciesAdapter()
    await expect(adapter.probe()).rejects.toThrow(`${'注'.repeat(200)}…`)
    vi.unstubAllGlobals()
  })

  it('网络失败抛中文错误', async () => {
    const fetchMock = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpDependenciesAdapter()
    await expect(adapter.probe()).rejects.toThrow('依赖检测请求网络失败')
    vi.unstubAllGlobals()
  })

  it('响应不是有效 JSON 抛中文错误', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpDependenciesAdapter()
    await expect(adapter.probe()).rejects.toThrow('依赖检测响应不是有效 JSON')
    vi.unstubAllGlobals()
  })
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
