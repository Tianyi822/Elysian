import { beforeEach, describe, expect, it } from 'vitest'
import { resetSshPanel, sshSessions } from '../test/sshPanel'
import { useSshStore } from './sshStore'
import type { SshOverview } from '@elysian/contracts'

beforeEach(() => resetSshPanel())
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
describe('SSH 状态刷新与身份隔离', () => {
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
    expect(useSshStore.getState()).toMatchObject({ status: 'ready', refreshing: false, refreshError: '离线', portDraft: '5432' })
    await useSshStore.getState().load(session.gateway)
    expect(useSshStore.getState().refreshError).toBeUndefined()
    expect(useSshStore.getState().portDraft).toBe('5432')
  })
})
