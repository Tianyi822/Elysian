import { describe, expect, it } from 'vitest'
import type { WebsiteDocker } from './websitesDocker.ts'
import type { WebsiteCaddy } from './websitesCaddy.ts'
import { buildCaddyConfig, managedHosts } from './caddyConfig.ts'
import { createMemoryWebsiteCertificateStore } from './websitesCertificates.ts'
import { makeTestChain } from './websitesCertificateTestUtils.ts'
import { createMemoryWebsiteRegistry, type WebsiteRegistry } from './websitesRegistry.ts'
import { createWebsiteService, validateWebsiteAccessRequest, validateWebsiteCreateRequest } from './websitesService.ts'

const options = { adminListen: 'unix//run/caddy/admin.sock' }
function fixture(
  registry: WebsiteRegistry = createMemoryWebsiteRegistry(),
  trustedRoots?: readonly string[],
  /** null = 不注入（检验 service 的缺省 skipped 行为）；缺省注入记录型 fake 返回 opened。 */
  openFirewallPort?: ((port: number, note: string) => Promise<{ state: 'opened' | 'skipped' | 'failed'; port: number; detail: string | null }>) | null,
) {
  const calls: string[] = []
  const portOpens: Array<{ port: number; note: string }> = []
  const states = new Map<string, boolean>()
  let sequence = 0
  let config: unknown = buildCaddyConfig([], options)
  let failLoad = false
  const docker: WebsiteDocker = {
    async ensureImage(ref) { calls.push(`image:${ref}`) },
    async ensureSiteDir(name) { return `/srv/wwwroot/${name}` },
    newContainerName() { return `elysian-site-${String(++sequence).padStart(12, '0')}` },
    async create(input) { const id = sequence.toString(16).padStart(64, '0'); states.set(id, false); calls.push(`create:${input.kind}:${input.accessMode}:${input.port}`); return { containerId: id } },
    async start(id) { states.set(id, true); calls.push(`start:${id}`) },
    async stop(id) { states.set(id, false); calls.push(`stop:${id}`) },
    async inspect(id) { if (!states.has(id)) throw new Error('容器不存在'); return { State: { Running: states.get(id), Pid: states.get(id) ? 123 : 0 } } },
    async logs(id) { return [`容器 ${id} 日志`] },
    async removeManaged(identity) { states.delete(identity.containerId); calls.push(`remove:${identity.containerId}`); return 'removed' },
    async removeCreated(id) { states.delete(id); calls.push(`rollback:${id}`) },
    async removeSiteDir() { calls.push('remove-dir') },
  }
  const caddy: WebsiteCaddy = {
    adminListen: options.adminListen,
    async currentConfig() { return config },
    async load(next) { if (failLoad) throw new Error('模拟下发失败'); config = next; calls.push('caddy-load') },
  }
  const service = createWebsiteService({ registry, docker, caddy, certificates: createMemoryWebsiteCertificateStore(), trustedRoots,
    mountRoot: '/srv', listPortBindings: async () => [],
    ...(openFirewallPort === null ? {} : { openFirewallPort: openFirewallPort ?? (async (port: number, note: string) => { portOpens.push({ port, note }); return { state: 'opened' as const, port, detail: null } }) }) })
  return { service, calls, portOpens, states, getConfig: () => config, setConfig: (next: unknown) => { config = next }, setFailLoad: (value: boolean) => { failLoad = value }, registry }
}

function request(kind: 'node' | 'html' = 'node', port = 3000, name = 'site') {
  return validateWebsiteCreateRequest({ kind, name, port, runtimeVersion: kind === 'html' ? null : '24.21.0',
    access: { mode: 'direct' }, command: kind === 'html' ? null : 'node dist/server.js' })
}

describe('网站访问与容器编排', () => {
  it('HTML 和 Node 均创建已停止容器；直连无需 Caddy 路由', async () => {
    const { service, calls } = fixture()
    const node = (await service.create(request())).project
    const html = (await service.create(request('html', 8088, 'docs'))).project
    expect(node.accessMode).toBe('direct')
    expect(node.runState).toBe('stopped')
    expect(node.containerId).toMatch(/^[0-9a-f]{64}$/)
    expect(html.containerId).toMatch(/^[0-9a-f]{64}$/)
    expect(html.deployCommand).toBe('nginx -g daemon off;')
    expect(calls).toContain('image:nginx:1.30.4-alpine3.24')
    expect(calls.some((call) => call.startsWith('start:'))).toBe(false)
    await service.setRunning(html.id, true)
    expect(await service.logs(html.id)).toHaveLength(1)
  })

  it('域名必需证书，大小写归一并拒绝跨项目重复', async () => {
    const chain = makeTestChain()
    const { service } = fixture(undefined, [chain.rootPem])
    expect(() => validateWebsiteCreateRequest({ kind: 'html', name: 'x', port: 8080, access: { mode: 'domain', domain: 'example.com' } })).toThrow('证书链')
    const created = (await service.create(validateWebsiteCreateRequest({ kind: 'html', name: 'a', port: 8080,
      access: { mode: 'domain', domain: 'EXAMPLE.COM', certificatePem: chain.certificatePem, privateKeyPem: chain.privateKeyPem } }))).project
    expect(created.domain).toBe('example.com')
    expect(created.routeApplied).toBe(true)
    expect(created.certificate?.applied).toBe(true)
    expect(JSON.stringify(created)).not.toContain('PRIVATE KEY')
    expect(JSON.stringify(await service.list())).not.toContain('PRIVATE KEY')
    await expect(service.create(validateWebsiteCreateRequest({ kind: 'html', name: 'b', port: 8081,
      access: { mode: 'domain', domain: 'example.com', certificatePem: chain.certificatePem, privateKeyPem: chain.privateKeyPem } }))).rejects.toThrow('域名已被绑定')
  })

  it('切换直连和域名时重建容器、保留目录，并回收旧路由', async () => {
    const chain = makeTestChain()
    const { service, calls } = fixture(undefined, [chain.rootPem])
    const direct = (await service.create(request())).project
    await service.setRunning(direct.id, true)
    const domain = (await service.setAccess(direct.id, validateWebsiteAccessRequest({ mode: 'domain', domain: 'example.com', certificatePem: chain.certificatePem, privateKeyPem: chain.privateKeyPem }))).project
    expect(domain.containerId).not.toBe(direct.containerId)
    expect(domain.rootDir).toBe(direct.rootDir)
    expect(domain.runState).toBe('running')
    expect(domain.routeApplied).toBe(true)
    const reverted = (await service.setAccess(direct.id, { mode: 'direct' })).project
    expect(reverted.domain).toBeNull()
    expect(reverted.certificate).toBeNull()
    expect(calls.filter((call) => call.startsWith('remove:'))).toHaveLength(2)
  })

  it('同域名替换证书只更新证书指纹，不重建容器', async () => {
    const first = makeTestChain()
    const second = makeTestChain()
    const { service, calls } = fixture(undefined, [first.rootPem, second.rootPem])
    const created = (await service.create(validateWebsiteCreateRequest({ kind: 'html', name: 'docs', port: 8088,
      access: { mode: 'domain', domain: 'example.com', certificatePem: first.certificatePem, privateKeyPem: first.privateKeyPem } }))).project
    const updated = (await service.setAccess(created.id, { mode: 'domain', domain: 'example.com', certificatePem: second.certificatePem, privateKeyPem: second.privateKeyPem })).project
    expect(updated.containerId).toBe(created.containerId)
    expect(updated.certificate?.fingerprint256).not.toBe(created.certificate?.fingerprint256)
    expect(updated.certificate?.applied).toBe(true)
    expect(calls.filter((call) => call.startsWith('create:'))).toHaveLength(1)
  })

  it('Caddy 下发失败恢复原容器和登记', async () => {
    const chain = makeTestChain()
    const { service, setFailLoad, registry, states } = fixture(undefined, [chain.rootPem])
    const direct = (await service.create(request())).project
    await service.setRunning(direct.id, true)
    setFailLoad(true)
    await expect(service.setAccess(direct.id, { mode: 'domain', domain: 'example.com', certificatePem: chain.certificatePem, privateKeyPem: chain.privateKeyPem })).rejects.toThrow('原访问配置已恢复')
    expect((await registry.list())[0]?.accessMode).toBe('direct')
    expect(states.get(direct.containerId!)).toBe(true)
    expect((await service.list()).projects[0]?.accessMode).toBe('direct')
  })

  it('登记失败后恢复原 Caddy 配置并移除新容器', async () => {
    const chain = makeTestChain()
    const backing = createMemoryWebsiteRegistry()
    const failing: WebsiteRegistry = { list: () => backing.list(), remove: (id) => backing.remove(id), put: async () => { throw new Error('模拟登记失败') } }
    const { service, calls, states, getConfig } = fixture(failing, [chain.rootPem])
    const before = JSON.stringify(getConfig())
    await expect(service.create(validateWebsiteCreateRequest({ kind: 'html', name: 'docs', port: 8088,
      access: { mode: 'domain', domain: 'example.com', certificatePem: chain.certificatePem, privateKeyPem: chain.privateKeyPem } }))).rejects.toThrow('网站创建失败：模拟登记失败')
    expect(JSON.stringify(getConfig())).toBe(before)
    expect(states.size).toBe(0)
    expect(calls.some((call) => call.startsWith('rollback:'))).toBe(true)
  })

  it('并发创建与访问切换由全局互斥阻止', async () => {
    const { service } = fixture()
    const existing = (await service.create(request())).project
    const creating = service.create(request('html', 8088, 'docs'))
    await expect(service.setAccess(existing.id, { mode: 'direct' })).rejects.toThrow('项目正在执行其他操作')
    await expect(service.create(request('html', 8089, 'other'))).rejects.toThrow('网站项目正在创建')
    await creating
  })

  it('拒绝覆盖同一 Caddy server 内的未知域名路由', async () => {
    const chain = makeTestChain()
    const { service, setConfig } = fixture(undefined, [chain.rootPem])
    const current = buildCaddyConfig([{ kind: 'proxy', domain: 'foreign.example.com', port: 8089 }], options)
    setConfig(current)
    await expect(service.create(validateWebsiteCreateRequest({ kind: 'html', name: 'docs', port: 8088,
      access: { mode: 'domain', domain: 'example.com', certificatePem: chain.certificatePem, privateKeyPem: chain.privateKeyPem } }))).rejects.toThrow('面板外的配置')
  })

  it('删除与创建串行，删除后不残留旧域名路由', async () => {
    const chain = makeTestChain()
    const { service, registry, getConfig } = fixture(undefined, [chain.rootPem])
    const created = (await service.create(validateWebsiteCreateRequest({ kind: 'html', name: 'docs', port: 8088,
      access: { mode: 'domain', domain: 'example.com', certificatePem: chain.certificatePem, privateKeyPem: chain.privateKeyPem } }))).project
    const removing = service.remove(created.id)
    await expect(service.create(request('html', 8089, 'other'))).rejects.toThrow('网站项目正在创建')
    await removing
    expect(await registry.list()).toHaveLength(0)
    expect(managedHosts(getConfig()).size).toBe(0)
  })

  it('命令修改重建容器，保留根目录', async () => {
    const { service } = fixture()
    const original = (await service.create(request())).project
    const updated = await service.update(original.id, { command: 'node "new server.js"' })
    expect(updated.containerId).not.toBe(original.containerId)
    expect(updated.rootDir).toBe(original.rootDir)
    expect(updated.deployCommand).toBe('node "new server.js"')
  })
})

describe('直连端口的防火墙自动开放', () => {
  it('直连创建在登记落账后开放端口并带回结果；域名创建不触发', async () => {
    const chain = makeTestChain()
    const { service, portOpens } = fixture(undefined, [chain.rootPem])
    const direct = await service.create(request('node', 18080, 'direct-site'))
    expect(direct.firewallPort).toEqual({ state: 'opened', port: 18080, detail: null })
    expect(portOpens).toEqual([{ port: 18080, note: 'Elysian 网站 direct-site' }])

    const domain = await service.create(validateWebsiteCreateRequest({ kind: 'html', name: 'docs', port: 8088,
      access: { mode: 'domain', domain: 'example.com', certificatePem: chain.certificatePem, privateKeyPem: chain.privateKeyPem } }))
    expect(domain.firewallPort).toBeNull()
    expect(portOpens).toHaveLength(1)
  })

  it('切换为直连开放端口；域名到域名换证书不触发', async () => {
    const chain = makeTestChain()
    const second = makeTestChain()
    const { service, portOpens } = fixture(undefined, [chain.rootPem, second.rootPem])
    const created = (await service.create(validateWebsiteCreateRequest({ kind: 'html', name: 'docs', port: 8088,
      access: { mode: 'domain', domain: 'example.com', certificatePem: chain.certificatePem, privateKeyPem: chain.privateKeyPem } }))).project
    const reverted = await service.setAccess(created.id, { mode: 'direct' })
    expect(reverted.firewallPort).toEqual({ state: 'opened', port: 8088, detail: null })
    expect(portOpens).toEqual([{ port: 8088, note: 'Elysian 网站 docs' }])

    const again = (await service.setAccess(created.id, { mode: 'domain', domain: 'example.com', certificatePem: second.certificatePem, privateKeyPem: second.privateKeyPem })).project
    expect(again.accessMode).toBe('domain')
    expect(portOpens).toHaveLength(1)
  })

  it('开口失败不影响创建成功：结果如实带回', async () => {
    const { service, registry } = fixture(undefined, undefined,
      async (port) => ({ state: 'failed', port, detail: '端口规则已达上限（最多 200 条）' }))
    const result = await service.create(request('node', 18081, 'blocked-site'))
    expect(result.project.accessMode).toBe('direct')
    expect(result.firewallPort).toEqual({ state: 'failed', port: 18081, detail: '端口规则已达上限（最多 200 条）' })
    expect((await registry.list())).toHaveLength(1)
  })

  it('未注入开口函数（测试与非容器装配）：恒 skipped 不打扰', async () => {
    const { service, calls, portOpens } = fixture(undefined, undefined, null)
    const result = await service.create(request())
    expect(result.firewallPort).toEqual({ state: 'skipped', port: 3000, detail: '防火墙片不可用，端口未自动开放' })
    expect(portOpens).toHaveLength(0)
    expect(calls.some((call) => call.startsWith('caddy-load'))).toBe(false)
  })
})
