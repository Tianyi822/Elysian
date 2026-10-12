import { describe, expect, it, vi } from 'vitest'
import type { AgentChatAdapter, AgentChatAttachment, AgentChatSession } from '../contracts/agentChat'
import type { ElysianGateway, SessionAdapter } from '../contracts/adapters'
import { createAgentChatStore, useAgentChatStore } from './agentChatStore'
import { useSessionStore } from './sessionStore'

function localMemory() {
  let saved: AgentChatSession | null = null
  const listeners = new Set<() => void>()
  const files = new Map<string, File>()
  let sequence = 0
  const adapter: AgentChatAdapter = {
    read: () => saved && structuredClone(saved),
    write(session) { saved = structuredClone(session); return true },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async attach(input) {
      const attachments: AgentChatAttachment[] = input.map(file => {
        const id = `file-${++sequence}`
        files.set(id, file)
        return { id, name: file.name, size: file.size, type: file.type, lastModified: file.lastModified, available: true }
      })
      return { attachments, persisted: true }
    },
    async restore(attachments) { return attachments.map(attachment => ({ ...attachment, available: files.has(attachment.id) })) },
    async discard(ids) { ids.forEach(id => files.delete(id)) },
  }
  const makeStore = () => createAgentChatStore(adapter, () => '2026-10-12T00:00:00.000Z', () => `id-${++sequence}`)
  return { adapter, makeStore, files, publish: () => listeners.forEach(listener => listener()) }
}

describe('智能体本地会话', () => {
  it('首次进入创建会话，刷新恢复文本、消息与选择，不创建新会话', async () => {
    const local = localMemory()
    const first = local.makeStore()
    await first.getState().ensureSession()
    first.getState().setDraft('检查容器日志')
    first.getState().setPermissionMode('assist')
    first.getState().setModel('model-1')
    first.getState().setReasoningLevel('high')
    expect(first.getState().send()).toBe(true)
    first.getState().setDraft('接下来查看磁盘')
    const second = local.makeStore()
    await second.getState().ensureSession()
    expect(second.getState().session).toEqual(first.getState().session)
    expect(second.getState().session?.messages).toHaveLength(1)
  })

  it('批量接收不同文件类型，发送只记录本地 user 消息及当时选择', async () => {
    const { makeStore } = localMemory()
    const store = makeStore()
    await store.getState().addAttachments([
      new File(['image'], 'diagram.png', { type: 'image/png' }),
      new File(['logs'], 'error.log', { type: 'text/plain' }),
      new File(['archive'], 'project.zip', { type: 'application/zip' }),
    ])
    store.getState().setPermissionMode('full')
    expect(store.getState().send()).toBe(true)
    expect(store.getState().session?.attachments).toEqual([])
    expect(store.getState().session?.messages[0]).toMatchObject({ role: 'user', text: '', permissionMode: 'full' })
    expect(store.getState().session?.messages[0]?.attachments.map(attachment => attachment.name)).toEqual(['diagram.png', 'error.log', 'project.zip'])
  })

  it('刷新后文件字节丢失时明确标记，不允许把文件名伪装成附件发送', async () => {
    const local = localMemory()
    const first = local.makeStore()
    await first.getState().addAttachments([new File(['a'], 'a.txt')])
    local.files.clear()
    const restored = local.makeStore()
    await restored.getState().ensureSession()
    expect(restored.getState().session?.attachments[0]?.available).toBe(false)
    expect(restored.getState().notice).toContain('无法从浏览器恢复')
    expect(restored.getState().send()).toBe(false)
    expect(restored.getState().session?.messages).toEqual([])
  })

  it('另一标签登录的新会话覆盖旧会话与草稿', async () => {
    const local = localMemory()
    const first = local.makeStore()
    await first.getState().ensureSession()
    first.getState().setDraft('旧草稿')
    const second = local.makeStore()
    await second.getState().ensureSession()
    const oldId = second.getState().session?.id
    await first.getState().newSession()
    local.publish()
    await Promise.resolve()
    expect(second.getState().session?.id).not.toBe(oldId)
    expect(second.getState().session?.draft).toBe('')
    second.getState().setDraft('新草稿')
    expect(local.adapter.read()?.id).toBe(first.getState().session?.id)
  })

  it('storage 事件尚未到达时也不能把旧登录会话写回', async () => {
    const local = localMemory()
    const first = local.makeStore()
    const second = local.makeStore()
    await first.getState().ensureSession()
    await second.getState().ensureSession()
    await first.getState().newSession()
    second.getState().setDraft('继续输入')
    expect(local.adapter.read()?.id).toBe(first.getState().session?.id)
    expect(local.adapter.read()?.draft).toBe('继续输入')
  })

  it('附件仍在保存期间重新登录，完成后清理附件并保持新会话空白', async () => {
    const local = localMemory()
    const originalAttach = local.adapter.attach
    let finish!: () => void
    let didStart!: () => void
    const started = new Promise<void>(resolve => { didStart = resolve })
    local.adapter.attach = async files => { await new Promise<void>(resolve => { finish = resolve; didStart() }); return originalAttach(files) }
    const store = local.makeStore()
    await store.getState().ensureSession()
    const pending = store.getState().addAttachments([new File(['a'], 'a.txt')])
    await started
    await store.getState().newSession()
    finish()
    await pending
    expect(store.getState().session?.attachments).toEqual([])
    expect(local.files.size).toBe(0)
  })
})

describe('登录与本地智能体会话', () => {
  const gateway = (session: Partial<SessionAdapter>) => ({ session } as unknown as ElysianGateway)

  it('只有成功登录创建新对话，探测与失败登录不重置', async () => {
    const reset = vi.spyOn(useAgentChatStore.getState(), 'newSession').mockResolvedValue()
    try {
      await useSessionStore.getState().probe(gateway({ status: async () => ({ mode: 'real', authenticated: true, devAccount: false }) }))
      expect(reset).not.toHaveBeenCalled()
      await expect(useSessionStore.getState().login(gateway({ login: async () => { throw new Error('用户名或密码错误') } }), 'admin', 'bad')).rejects.toThrow()
      expect(reset).not.toHaveBeenCalled()
      await useSessionStore.getState().login(gateway({ login: async () => {} }), 'admin', 'good')
      expect(reset).toHaveBeenCalledOnce()
    } finally { reset.mockRestore() }
  })
})
