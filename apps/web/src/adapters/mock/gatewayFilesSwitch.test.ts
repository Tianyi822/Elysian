import { describe, expect, it, vi } from 'vitest'
import { createMockGateway } from './gateway'
import {
  MockFilesAdapter,
  MockFirewallAdapter,
  MockSshAdapter,
  MockUserAdapter,
} from './mockAdapters'

/*
 * gateway 的可选片分流断言：文件管理是本轮新增，防火墙、SSH 与主机账号三片
 * 此前没有分流测试，这里把先例欠的账一并还上。事件流固定 'memory'，
 * 不创建指向不存在端点的 EventSource。
 */

describe('createMockGateway 可选片分流', () => {
  it('缺省装配：文件管理与既有三片都是内存演示实现', () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    expect(gateway.files).toBeInstanceOf(MockFilesAdapter)
    expect(gateway.firewall).toBeInstanceOf(MockFirewallAdapter)
    expect(gateway.ssh).toBeInstanceOf(MockSshAdapter)
    expect(gateway.users).toBeInstanceOf(MockUserAdapter)
  })

  it("显式 files: 'mock' 与缺省同款", () => {
    const gateway = createMockGateway({ eventStream: 'memory', files: 'mock' })
    expect(gateway.files).toBeInstanceOf(MockFilesAdapter)
  })

  it("files: 'http' 只把文件管理换成 HTTP adapter，既有三片不受影响", () => {
    const gateway = createMockGateway({ eventStream: 'memory', files: 'http' })
    expect(gateway.files).not.toBeInstanceOf(MockFilesAdapter)
    expect(gateway.firewall).toBeInstanceOf(MockFirewallAdapter)
    expect(gateway.ssh).toBeInstanceOf(MockSshAdapter)
    expect(gateway.users).toBeInstanceOf(MockUserAdapter)
  })

  it("files: 'http' 的请求落到同源 /api/files 端点", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ entries: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createMockGateway({ eventStream: 'memory', files: 'http' })
    await gateway.files.list('/var/log')
    expect(fetchMock).toHaveBeenCalledWith('/api/files/entries?path=%2Fvar%2Flog', undefined)
    vi.unstubAllGlobals()
  })

  it("firewall / ssh / users 各自的 'http' 选项只换自己那片", () => {
    const gateway = createMockGateway({
      eventStream: 'memory',
      firewall: 'http',
      ssh: 'http',
      users: 'http',
    })
    expect(gateway.firewall).not.toBeInstanceOf(MockFirewallAdapter)
    expect(gateway.ssh).not.toBeInstanceOf(MockSshAdapter)
    expect(gateway.users).not.toBeInstanceOf(MockUserAdapter)
    expect(gateway.files).toBeInstanceOf(MockFilesAdapter)
  })
})
