import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebsiteProject } from '@elysian/contracts'
import { createMockGateway } from '../adapters/mock/gateway'
import { resetWebsitesData } from '../adapters/mock/websitesData'
import { useMessageStore } from './messageStore'
import { useWebsitesStore } from './websitesStore'

beforeEach(async () => {
  await useMessageStore.getState().clear()
  resetWebsitesData()
  useWebsitesStore.setState({ status: 'idle', projects: [], createDialogOpen: false, saving: false,
    busyProjectIds: [], proxyStatus: { state: 'active', detail: null } })
})

describe('网站状态', () => {
  it('本地演示从空列表创建直连站点', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    await useWebsitesStore.getState().load(gateway)
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
    expect(saved.routeApplied).toBe(true)
    expect(saved.certificate?.applied).toBe(true)
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
