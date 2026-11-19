import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebsiteProject } from '@elysian/contracts'
import { createMockGateway } from '../adapters/mock/gateway'
import { resetWebsitesData } from '../adapters/mock/websitesData'
import { useMessageStore } from './messageStore'
import { useSessionStore } from './sessionStore'
import { useWebsitesStore } from './websitesStore'

beforeEach(async () => {
  await useMessageStore.getState().clear()
  resetWebsitesData()
  useWebsitesStore.getState().clearDisplay()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure })
  return { promise, resolve, reject }
}

describe('网站项目登录会话边界', () => {
  beforeEach(() => useSessionStore.setState({ phase: 'authed', mode: 'real', username: 'admin' }))

  it.each(['成功', '失败'] as const)('旧启停%s不覆盖新会话的同项目状态或解除忙碌', async (outcome) => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const { project } = await gateway.websites.create('html', { name: 'docs', port: 8088, access: { mode: 'direct' } })
    const old = deferred<WebsiteProject>()
    const next = deferred<WebsiteProject>()
    vi.spyOn(gateway.websites, 'setRunning').mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const store = useWebsitesStore.getState()
    const session = useSessionStore.getState()
    await store.load(gateway, { silent: true })
    const beforeLogout = store.setRunning(gateway, project, true)
    await session.logout(gateway)
    await session.login(gateway, 'admin', 'password')
    await store.load(gateway, { silent: true })
    const afterLogin = store.setRunning(gateway, project, false)

    if (outcome === '成功') old.resolve({ ...project, runState: 'running' })
    else old.reject(new Error('旧会话启停失败'))
    await beforeLogout
    const snapshot = useWebsitesStore.getState()
    const messages = useMessageStore.getState().messages.slice()
    next.resolve({ ...project, runState: 'stopped', pid: null })
    await afterLogin

    expect(snapshot.projects[0]?.runState).toBe('stopped')
    expect(snapshot.busyProjectIds).toEqual([project.id])
    expect(messages).toEqual([])
    expect(useMessageStore.getState().messages).toHaveLength(1)
  })

  it.each(['成功', '失败'] as const)('失效时清除详情与日志，访问配置迟到%s不回读或给弹窗反馈', async (outcome) => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const result = await gateway.websites.create('html', { name: 'docs', port: 8088, access: { mode: 'direct' } })
    const old = deferred<typeof result>()
    vi.spyOn(gateway.websites, 'setAccess').mockReturnValueOnce(old.promise)
    vi.spyOn(gateway.websites, 'logs').mockResolvedValue(['旧会话日志'])
    const list = vi.spyOn(gateway.websites, 'list')
    const store = useWebsitesStore.getState()
    await store.load(gateway, { silent: true })
    await store.openDetail(gateway, result.project)
    const pending = store.saveAccess(gateway, result.project.id, { mode: 'direct' })
    useSessionStore.getState().expire()
    list.mockClear()

    if (outcome === '成功') old.resolve(result)
    else old.reject(new Error('旧访问配置失败'))
    await expect(pending).resolves.toBeUndefined()
    expect(useWebsitesStore.getState()).toMatchObject({ status: 'idle', projects: [], detailTarget: undefined, detailLogs: undefined, busyProjectIds: [] })
    expect(list).not.toHaveBeenCalled()
    expect(useMessageStore.getState().messages).toEqual([])
  })
})

describe('网站状态', () => {
  it('本地演示从空列表创建直连站点', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    await useWebsitesStore.getState().load(gateway, { silent: true })
    expect(useWebsitesStore.getState().projects).toEqual([])
    const ok = await useWebsitesStore.getState().createProject(gateway, 'html', { name: 'docs', port: 8088, access: { mode: 'direct' } })
    expect(ok).toBe(true)
    expect(useWebsitesStore.getState().projects[0]?.accessMode).toBe('direct')
    expect(useMessageStore.getState().messages[0]?.message).toBe('项目 docs 已添加（演示数据，刷新后还原）')
  })

  it('保存访问配置后刷新出路由和证书事实', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    await useWebsitesStore.getState().createProject(gateway, 'html', { name: 'docs', port: 8088, access: { mode: 'direct' } })
    const projectId = useWebsitesStore.getState().projects[0]!.id
    const saved = await useWebsitesStore.getState().saveAccess(gateway, projectId, { mode: 'domain', domain: 'example.com', certificatePem: 'cert', privateKeyPem: 'key' })
    expect(saved).toMatchObject({ routeApplied: true, certificate: { applied: true } })
    expect(useWebsitesStore.getState().projects[0]?.domain).toBe('example.com')
  })

  it('同一项目互斥，不同项目独立解锁，启停失败回滚原状态', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    const { createProject, setRunning, saveAccess, removeProject } = useWebsitesStore.getState()
    await createProject(gateway, 'html', { name: 'docs', port: 8088, access: { mode: 'direct' } })
    await createProject(gateway, 'html', { name: 'blog', port: 8089, access: { mode: 'direct' } })
    const [docs, blog] = useWebsitesStore.getState().projects as readonly [WebsiteProject, WebsiteProject]
    let reject!: (reason: Error) => void
    const pending = new Promise<WebsiteProject>((_, fail) => { reject = fail })
    vi.spyOn(gateway.websites, 'setRunning').mockReturnValue(pending)
    const remove = vi.spyOn(gateway.websites, 'remove')

    const running = docs.runState !== 'running'
    const change = setRunning(gateway, docs, running)
    expect(useWebsitesStore.getState().projects[0]?.runState).toBe(running ? 'running' : 'stopped')
    await expect(saveAccess(gateway, docs.id, { mode: 'direct' })).rejects.toThrow('项目正在执行其他操作')
    await removeProject(gateway, docs)
    expect(remove).not.toHaveBeenCalled()

    const removing = removeProject(gateway, blog)
    expect(useWebsitesStore.getState().busyProjectIds).toEqual([docs.id, blog.id])
    await removing
    expect(useWebsitesStore.getState().busyProjectIds).toEqual([docs.id])

    reject(new Error('启停失败'))
    await change
    expect(useWebsitesStore.getState()).toMatchObject({ busyProjectIds: [], projects: [docs] })
  })
})
