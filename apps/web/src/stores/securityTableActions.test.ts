import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../adapters/mock/gateway'
import { advanceAuthGeneration } from '../adapters/http/unauthorized'
import { RequestTimeoutError } from '../adapters/http/requestDeadline'
import { resetSshPanel, sshSessions, userSessions } from '../test/sshPanel'
import { useFirewallStore } from './firewallStore'
import { useUsersStore } from './usersStore'
import { useSshStore } from './sshStore'

beforeEach(async () => {
  await resetSshPanel()
  useFirewallStore.setState(useFirewallStore.getInitialState())
})

describe('安全表格共用执行回执', () => {
  it('账号删除只在可信成功响应后移除，失败不伪报成功', async () => {
    const { gateway } = userSessions()
    await useUsersStore.getState().load(gateway)
    const user = useUsersStore.getState().users[0]!
    vi.spyOn(gateway.users, 'remove').mockRejectedValueOnce(new Error('连接中断'))
    expect(await useUsersStore.getState().removeUser(gateway, user.id)).toEqual({ status: 'unknown', error: '连接中断' })
    expect(useUsersStore.getState().users).toContain(user)
    expect(await useUsersStore.getState().removeUser(gateway, user.id)).toEqual({ status: 'succeeded' })
    expect(useUsersStore.getState().users.some(item => item.id === user.id)).toBe(false)
  })
  it('SSH 忙碌时明确返回未执行失败；超时保留未知且不自动重投', async () => {
    const { gateway } = sshSessions()
    await useSshStore.getState().load(gateway)
    const key = useSshStore.getState().keys[0]!
    const remove = vi.spyOn(gateway.ssh, 'removeKey').mockRejectedValue(new RequestTimeoutError(true))
    useSshStore.setState({ savingPort: true })
    expect((await useSshStore.getState().removeKey(gateway, key.id)).status).toBe('failed')
    expect(remove).not.toHaveBeenCalled()
    useSshStore.setState({ savingPort: false })
    expect((await useSshStore.getState().removeKey(gateway, key.id)).status).toBe('unknown')
    expect(remove).toHaveBeenCalledTimes(1)
    expect(useSshStore.getState().keys.some(item => item.id === key.id)).toBe(true)
  })
  it('防火墙删除与解封异常返回未知，不把吞掉的异常当成功', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60000 })
    vi.spyOn(gateway.firewall, 'remove').mockRejectedValue(new Error('系统写入后回读失败'))
    vi.spyOn(gateway.firewall, 'unblockIp').mockRejectedValue(new RequestTimeoutError(true))
    expect((await useFirewallStore.getState().removeRule(gateway, 'port', 'old-rule')).status).toBe('unknown')
    expect((await useFirewallStore.getState().unblockIp(gateway, '192.0.2.1')).status).toBe('unknown')
  })
  it('账号删除回执迟于登录代次变化时不改写新会话状态', async () => {
    const { gateway } = userSessions()
    await useUsersStore.getState().load(gateway)
    const user = useUsersStore.getState().users[0]!
    let finish!: () => void
    vi.spyOn(gateway.users, 'remove').mockReturnValue(new Promise(resolve => { finish = resolve }))
    const pending = useUsersStore.getState().removeUser(gateway, user.id)
    expect(useUsersStore.getState().removingUserIds).toEqual([user.id])
    advanceAuthGeneration()
    vi.spyOn(gateway.users, 'list').mockResolvedValue([user])
    await useUsersStore.getState().load(gateway)
    expect(useUsersStore.getState().removingUserIds).toEqual([])
    finish()
    expect((await pending).status).toBe('unknown')
    expect(useUsersStore.getState().users).toEqual([user])
  })
})
