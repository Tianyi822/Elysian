import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSshPanel, sshSessions } from '../test/sshPanel'
import { useSshStore } from './sshStore'
import type { SshLoginRecord, SshOverview } from '@elysian/contracts'

beforeEach(() => resetSshPanel())
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
describe('SSH 状态刷新与身份隔离', () => {
  it.each([
    { section: 'service', calls: ['overview', 'settings'] },
    { section: 'root', calls: ['rootAuth', 'settings'] },
    { section: 'keys', calls: ['listKeys', 'keyAccounts'] },
    { section: 'records', calls: ['listLoginRecords'] },
  ] as const)('$section 刷新只读取所属卡片的数据', async ({ section, calls }) => {
    const { gateway } = sshSessions()
    await useSshStore.getState().load(gateway)
    const reads = ['overview', 'settings', 'rootAuth', 'listKeys', 'keyAccounts', 'listLoginRecords'] as const
    const spies = reads.map(name => ({ name, spy: vi.spyOn(gateway.ssh, name) }))
    await useSshStore.getState().refreshSection(gateway, section)
    for (const { name, spy } of spies) expect(spy).toHaveBeenCalledTimes((calls as readonly string[]).includes(name) ? 1 : 0)
  })

  it('同一区域合并读取，不同卡片的刷新状态独立完成', async () => {
    const { gateway } = sshSessions()
    await useSshStore.getState().load(gateway)
    const overview = useSshStore.getState().overview!
    const records = useSshStore.getState().loginRecords
    const service = deferred<SshOverview>(), history = deferred<readonly SshLoginRecord[]>()
    const serviceRead = vi.spyOn(gateway.ssh, 'overview').mockReturnValue(service.promise)
    vi.spyOn(gateway.ssh, 'listLoginRecords').mockReturnValue(history.promise)
    const first = useSshStore.getState().refreshSection(gateway, 'service')
    const duplicate = useSshStore.getState().refreshSection(gateway, 'service')
    const other = useSshStore.getState().refreshSection(gateway, 'records')
    expect(first).toBe(duplicate)
    expect(serviceRead).toHaveBeenCalledTimes(1)
    expect(useSshStore.getState().sectionRefreshing).toEqual({ service: true, root: false, keys: false, records: true })
    service.resolve(overview)
    await first
    expect(useSshStore.getState().sectionRefreshing).toEqual({ service: false, root: false, keys: false, records: true })
    history.resolve(records)
    await other
    expect(useSshStore.getState().sectionRefreshing.records).toBe(false)
  })

  it('Root 读取失败不阻止服务卡片更新认证配置', async () => {
    const { gateway } = sshSessions()
    await useSshStore.getState().load(gateway)
    const settings = useSshStore.getState().settings!
    vi.spyOn(gateway.ssh, 'settings').mockResolvedValue({ ...settings, port: 23456 })
    vi.spyOn(gateway.ssh, 'rootAuth').mockRejectedValue(new Error('Root 读取失败'))
    await Promise.all([
      useSshStore.getState().refreshSection(gateway, 'service'),
      useSshStore.getState().refreshSection(gateway, 'root'),
    ])
    expect(useSshStore.getState().settings?.port).toBe(23456)
    expect(useSshStore.getState().sectionErrors).toMatchObject({ root: 'Root 读取失败' })
    expect(useSshStore.getState().sectionErrors.service).toBeUndefined()
  })

  it('刷新登录数据保留草稿和分页；停服清空设置弹窗与密码', async () => {
    const session = sshSessions()
    await useSshStore.getState().load(session.gateway)
    useSshStore.setState({ portDraft: '2345', passwordDraft: 'draft', recordPage: 2, pendingPort: 2345, createKeyOpen: true })
    await useSshStore.getState().refresh(session.gateway)
    expect(useSshStore.getState()).toMatchObject({ portDraft: '2345', passwordDraft: 'draft', recordPage: 2 })
    await session.ssh.setServiceEnabled(false)
    await useSshStore.getState().refresh(session.gateway)
    expect(useSshStore.getState()).toMatchObject({ passwordDraft: '', pendingPort: undefined, createKeyOpen: false })
    expect(useSshStore.getState().overview?.stats).toBeDefined()
  })
  it('旧刷新结果不能覆盖启停回执', async () => {
    const session = sshSessions()
    await useSshStore.getState().load(session.gateway)
    const old = useSshStore.getState().overview!
    const pending = deferred<SshOverview>()
    const gateway = { ...session.gateway, ssh: { ...session.gateway.ssh, overview: () => pending.promise } }
    const refresh = useSshStore.getState().refresh(gateway)
    await useSshStore.getState().setServiceEnabled(session.gateway, false)
    pending.resolve(old)
    await refresh
    expect(useSshStore.getState().overview?.enabled).toBe(false)
  })
  it('清除身份后丢弃迟到读取与私钥生成回执', async () => {
    const session = sshSessions()
    const overview = await session.ssh.overview()
    const pending = deferred<SshOverview>()
    const loading = useSshStore.getState().load({ ...session.gateway, ssh: { ...session.gateway.ssh, overview: () => pending.promise } })
    useSshStore.getState().clearDisplay()
    pending.resolve(overview); await loading
    expect(useSshStore.getState().overview).toBeUndefined()
    await useSshStore.getState().load(session.gateway)
    const key = await session.ssh.createRootKey()
    const receipt = deferred<typeof key>()
    const generating = useSshStore.getState().createRootKey({ ...session.gateway, ssh: { ...session.gateway.ssh, createRootKey: () => receipt.promise } })
    useSshStore.getState().clearDisplay(); receipt.resolve(key); await generating
    expect(useSshStore.getState().revealKey).toBeUndefined()
    expect(useSshStore.getState().rootAuth).toBeUndefined()
  })
  it('手动刷新保留已读取内容与编辑草稿，失败可恢复', async () => {
    const session = sshSessions()
    await useSshStore.getState().load(session.gateway)
    useSshStore.getState().setPortDraft('5432')
    const failing = { ...session.gateway, ssh: { ...session.gateway.ssh, overview: async () => { throw new Error('离线') } } }
    await useSshStore.getState().load(failing)
    expect(useSshStore.getState()).toMatchObject({ status: 'ready', sectionRefreshing: { service: false }, sectionErrors: { service: '离线' }, portDraft: '5432' })
    await useSshStore.getState().load(session.gateway)
    expect(useSshStore.getState().sectionErrors.service).toBeUndefined()
    expect(useSshStore.getState().portDraft).toBe('5432')
  })
})
