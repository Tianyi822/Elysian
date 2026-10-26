import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatSession } from '../../contracts/agentChat'
import { AGENT_CHAT_STORAGE_KEY, AGENT_CHAT_LEGACY_KEY, AGENT_CHAT_RECORD_PREFIX, createAgentChatLocalAdapter } from './agentChatLocalAdapter'

const session = (): AgentChatSession => ({ id: 'session-1', createdAt: '2026-10-12T00:00:00.000Z', draft: '草稿', messages: [], attachments: [], permissionMode: 'ask', permissionVersion: 1, modelId: null, reasoningLevel: null })

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('浏览器会话存储', () => {
  it('HTTP IP 环境下可保存和恢复图片附件，本地标识不依赖 randomUUID', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    try {
      const adapter = createAgentChatLocalAdapter()
      const result = await adapter.attach([new File(['png'], 'image.png', { type: 'image/png' })])
      expect(result.attachments[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
      adapter.write({ ...session(), attachments: result.attachments })
      expect((await adapter.restore(adapter.read()!.attachments))[0]?.available).toBe(true)
    } finally { vi.unstubAllGlobals() }
  })
  it.each([undefined, 'enabled'] as const)('pending 原样保留扩展模式 %s，刷新不补写旧请求', extensionMode => {
    const input = { requestId: 'fixed-request', content: '原消息', ...(extensionMode ? { extensionMode } : {}) }
    const adapter = createAgentChatLocalAdapter()
    adapter.write({ ...session(), pending: { input } })
    expect(createAgentChatLocalAdapter().read()?.pending?.input).toEqual(input)
  })

  it('拒绝未知扩展模式的持久化请求', () => {
    localStorage.setItem(AGENT_CHAT_RECORD_PREFIX + 'session-1', JSON.stringify({ ...session(), pending: { input: { requestId: 'fixed', content: '输入', extensionMode: 'invalid' } } }))
    expect(createAgentChatLocalAdapter().read('session-1')).toBeNull()
  })

  it.each(['assist', 'full'] as const)('旧版 %s 预览迁回 ask，保留草稿附件和精确重试', mode => {
    const legacy = { ...session(), permissionVersion: undefined, permissionMode: mode, pending: { input: { requestId: 'original', content: '原输入' } }, attachments: [{ id: 'local', name: 'a.png', size: 10, type: 'image/png', lastModified: 0, available: false }] }
    localStorage.setItem(AGENT_CHAT_RECORD_PREFIX + 'session-1', JSON.stringify(legacy))
    const adapter = createAgentChatLocalAdapter()
    const restored = adapter.read('session-1')!
    expect(restored).toMatchObject({ permissionMode: 'ask', permissionVersion: 1, draft: '草稿', pending: legacy.pending, attachments: legacy.attachments })
    adapter.write({ ...restored, permissionMode: 'full' })
    expect(createAgentChatLocalAdapter().read('session-1')?.permissionMode).toBe('full')
  })
  it('损坏或不兼容的数据安全回落，不阻止创建新会话', () => {
    const adapter = createAgentChatLocalAdapter()
    localStorage.setItem(AGENT_CHAT_STORAGE_KEY, '{broken')
    expect(adapter.read()).toBeNull()
    localStorage.setItem(AGENT_CHAT_STORAGE_KEY, JSON.stringify({ id: 'not-a-session' }))
    expect(adapter.read()).toBeNull()
    expect(adapter.write(session())).toBe(true)
    expect(adapter.read()).toEqual(session())
  })

  it('存储额度不足时保留最新内存会话，不重新读入旧会话', () => {
    const adapter = createAgentChatLocalAdapter()
    adapter.write(session())
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('额度不足', 'QuotaExceededError') })
    expect(adapter.write({ ...session(), id: 'session-2', draft: '新草稿' })).toBe(false)
    expect(adapter.read()).toMatchObject({ id: 'session-2', draft: '新草稿' })
  })

  it('持久文本不携带 blob URL，IndexedDB 不可用时刷新明确丢失文件可用性', async () => {
    const adapter = createAgentChatLocalAdapter()
    const result = await adapter.attach([new File(['hello'], 'a.txt', { type: 'text/plain' })])
    adapter.write({ ...session(), attachments: result.attachments })
    const saved = adapter.read()!
    expect(saved.attachments[0]?.available).toBe(false)
    expect((await adapter.restore(saved.attachments))[0]?.available).toBe(true)
    const refreshed = createAgentChatLocalAdapter()
    expect((await refreshed.restore(saved.attachments))[0]?.available).toBe(false)
  })

  it('storedAttachment 读写往返保留 serverId 与宽高，刷新后可发送判定不失效', () => {
    const adapter = createAgentChatLocalAdapter()
    const attachment = { id: 'file-1', name: '图.png', size: 71, type: 'image/png', lastModified: 0, serverId: 'server-attachment-1', width: 3, height: 4, available: true }
    adapter.write({ ...session(), attachments: [attachment],
      pending: { input: { requestId: 'r1', content: '看图', attachments: [{ id: 'server-attachment-1' }] } },
      editing: { messageId: 'message-1', taskId: 'task-1', text: '改写', attachments: [{ id: 'server-attachment-1' }] } })
    const saved = adapter.read()!
    expect(saved.attachments[0]).toMatchObject({ serverId: 'server-attachment-1', width: 3, height: 4 })
    expect(saved.attachments[0]?.available).toBe(false)
    expect(saved.attachments[0]?.previewUrl).toBeUndefined()
    expect(saved.pending?.input.attachments).toEqual([{ id: 'server-attachment-1' }])
    expect(saved.editing?.attachments).toEqual([{ id: 'server-attachment-1' }])
    // 二次写读同样保留：serverId 不被第一次 write/parse 剥掉。
    const again = createAgentChatLocalAdapter()
    expect(again.read()?.attachments[0]?.serverId).toBe('server-attachment-1')
  })

  it('无 serverId 的旧版存量附件照常恢复字节与预览，保持无 serverId 交由上层拦发送', async () => {
    const adapter = createAgentChatLocalAdapter()
    const result = await adapter.attach([new File(['png'], '旧图.png', { type: 'image/png' })])
    expect(result.attachments[0]?.serverId).toBeUndefined()
    adapter.write({ ...session(), attachments: result.attachments })
    const saved = adapter.read()!
    const restored = await adapter.restore(saved.attachments)
    expect(restored[0]?.available).toBe(true)
    expect(restored[0]?.serverId).toBeUndefined()
    expect(restored[0]?.previewUrl).toContain('blob:')
  })

  it('编辑图片处理缓存持久化引用和字节，刷新剥离预览但保留精确 pending', async () => {
    const adapter = createAgentChatLocalAdapter()
    const result = await adapter.attach([new File(['jpeg'], 'old.jpg', { type: 'image/jpeg' })])
    const attachment = { ...result.attachments[0]!, serverId: 'compressed-1', width: 1200, height: 800 }
    adapter.write({ ...session(),
      editing: { messageId: 'message-1', taskId: 'task-1', text: '重发', attachments: [{ id: 'original-1' }], preparedAttachments: [{ sourceId: 'original-1', attachment }] },
      pending: { input: { requestId: 'request-1', content: '重发', replaceMessageId: 'message-1', attachments: [{ id: 'compressed-1' }] } },
    })
    const saved = adapter.read()!
    const cached = saved.editing!.preparedAttachments![0]!
    expect(cached.sourceId).toBe('original-1')
    expect(cached.attachment).toMatchObject({ serverId: 'compressed-1', width: 1200, height: 800, size: 4, available: false })
    expect(cached.attachment.previewUrl).toBeUndefined()
    expect((await adapter.restore([cached.attachment]))[0]?.available).toBe(true)
    const refreshed = createAgentChatLocalAdapter().read()!
    expect(refreshed.editing?.preparedAttachments).toEqual(saved.editing?.preparedAttachments)
    expect(refreshed.pending?.input.attachments).toEqual([{ id: 'compressed-1' }])
  })
})


describe('多会话存储迁移与隔离', () => {
  it('v1 保留草稿、附件与精确 pending，写入完整 v2 后才清旧记录', () => {
    const legacy = { ...session(), remote: { sessionId: 'remote-a' }, pending: { input: { requestId: 'original-id', content: '原输入', reasoningLevel: 'high' } } }
    localStorage.setItem(AGENT_CHAT_LEGACY_KEY, JSON.stringify(legacy))
    const adapter = createAgentChatLocalAdapter()
    expect(adapter.read()).toEqual(legacy)
    expect(localStorage.getItem(AGENT_CHAT_LEGACY_KEY)).toBeNull()
    expect(localStorage.getItem(AGENT_CHAT_STORAGE_KEY)).toBe('remote-a')
    adapter.write({ ...session(), id: 'draft:b', draft: '另一条草稿' })
    expect(adapter.read('remote-a')?.pending?.input.requestId).toBe('original-id')
    expect(adapter.list()).toHaveLength(2)
  })

  it('迁移中途存储失败不会清除旧记录，恢复后可重试', () => {
    localStorage.setItem(AGENT_CHAT_LEGACY_KEY, JSON.stringify(session()))
    const original = Storage.prototype.setItem
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === AGENT_CHAT_STORAGE_KEY) throw new Error('存储已满')
      original.call(this, key, value)
    })
    const adapter = createAgentChatLocalAdapter()
    expect(adapter.read()?.draft).toBe('草稿')
    expect(localStorage.getItem(AGENT_CHAT_LEGACY_KEY)).not.toBeNull()
    failure.mockRestore()
    expect(adapter.read()?.draft).toBe('草稿')
    expect(localStorage.getItem(AGENT_CHAT_LEGACY_KEY)).toBeNull()
  })

  it('后台回执不更改选中指针，草稿转远端ID后不残留重复记录', () => {
    const adapter = createAgentChatLocalAdapter()
    adapter.write({ ...session(), id: 'draft:a' })
    adapter.write({ ...session(), id: 'draft:b' })
    adapter.write({ ...session(), id: 'draft:a', remote: { sessionId: 'remote-a' } }, false)
    expect(adapter.read()?.id).toBe('draft:b')
    expect(localStorage.getItem(AGENT_CHAT_RECORD_PREFIX + encodeURIComponent('draft:a'))).toBeNull()
    expect(adapter.list().map(row => row.id).sort()).toEqual(['draft:a', 'draft:b'])
  })

  it('remove 删除记录键、附件字节与选中指针，不影响其他会话记录', async () => {
    const adapter = createAgentChatLocalAdapter()
    const attached = await adapter.attach([new File(['b'], 'b.txt', { type: 'text/plain' })])
    adapter.write({ ...session(), id: 'draft:a', remote: { sessionId: 'remote-a' }, attachments: attached.attachments })
    adapter.write({ ...session(), id: 'draft:b' })
    expect(adapter.select('remote-a')).toBe(true)
    expect((await adapter.restore(attached.attachments))[0]?.available).toBe(true)
    adapter.remove('remote-a')
    expect(localStorage.getItem(AGENT_CHAT_RECORD_PREFIX + encodeURIComponent('remote-a'))).toBeNull()
    expect(localStorage.getItem(AGENT_CHAT_STORAGE_KEY)).toBeNull()
    expect(adapter.read('remote-a')).toBeNull()
    expect(adapter.list().map(row => row.id)).toEqual(['draft:b'])
    // 附件字节随记录一并释放：同一适配器内不再能恢复为可用。
    expect((await adapter.restore(attached.attachments))[0]?.available).toBe(false)
  })

  it('remove 不触碰 v1 迁移键，迁移不变量保持', () => {
    localStorage.setItem(AGENT_CHAT_LEGACY_KEY, JSON.stringify({ ...session(), remote: { sessionId: 'remote-legacy' } }))
    const adapter = createAgentChatLocalAdapter()
    expect(adapter.read()?.remote?.sessionId).toBe('remote-legacy')
    adapter.remove('draft:other')
    expect(localStorage.getItem(AGENT_CHAT_LEGACY_KEY)).toBeNull()
    expect(adapter.read('remote-legacy')).not.toBeNull()
    expect(localStorage.getItem(AGENT_CHAT_RECORD_PREFIX + encodeURIComponent('remote-legacy'))).not.toBeNull()
  })
})
