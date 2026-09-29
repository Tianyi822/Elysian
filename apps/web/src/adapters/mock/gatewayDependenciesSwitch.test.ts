import { describe, expect, it, vi } from 'vitest'
import { createMockGateway } from './gateway'
import { MockDependenciesAdapter } from './mockAdapters'

/*
 * gateway 的依赖检测片分流断言：缺省与 'mock' 装恒双 ok 的演示实现，
 * 'http' 换成同源 /api/platform/dependencies 的 HTTP adapter 且不影响既有各片。
 * 事件流固定 'memory'，不创建指向不存在端点的 EventSource。
 */

describe('createMockGateway 依赖检测片分流', () => {
  it('缺省装配：依赖检测片是恒双 ok 的演示实现', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    expect(gateway.dependencies).toBeInstanceOf(MockDependenciesAdapter)
    expect(await gateway.dependencies.probe()).toEqual({
      docker: { state: 'ok', detail: null },
      caddy: { state: 'ok', detail: null },
    })
  })

  it("显式 dependencies: 'mock' 与缺省同款", () => {
    const gateway = createMockGateway({ eventStream: 'memory', dependencies: 'mock' })
    expect(gateway.dependencies).toBeInstanceOf(MockDependenciesAdapter)
  })

  it("dependencies: 'http' 只把依赖检测片换成 HTTP adapter，网站片不受影响", () => {
    const gateway = createMockGateway({ eventStream: 'memory', dependencies: 'http' })
    expect(gateway.dependencies).not.toBeInstanceOf(MockDependenciesAdapter)
  })

  it("dependencies: 'http' 的探测落到同源 /api/platform/dependencies 端点并解析报告", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            docker: { state: 'missing', detail: 'Docker 未安装或未接通' },
            caddy: { state: 'missing', detail: '宿主未提供 Caddy 管理通道' },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createMockGateway({ eventStream: 'memory', dependencies: 'http' })
    const report = await gateway.dependencies.probe()
    expect(fetchMock).toHaveBeenCalledWith('/api/platform/dependencies', { cache: 'no-store' })
    expect(report).toEqual({
      docker: { state: 'missing', detail: 'Docker 未安装或未接通' },
      caddy: { state: 'missing', detail: '宿主未提供 Caddy 管理通道' },
    })
    vi.unstubAllGlobals()
  })
})
