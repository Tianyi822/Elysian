import { describe, expect, it } from 'vitest'
import type { AgentInput } from '@elysian/contracts'
import type { AgentChatAttachment, AgentChatRun, AgentChatSession } from '../contracts/agentChat'
import { AgentHttpError } from '../contracts/agentHttpError'
import { applySubmissionReceipt, isConfirmedRejection } from './agentChatSubmission'

const run: AgentChatRun = { id: 'run-2', taskId: 'task-1', requestId: 'request-2', status: 'running', phase: 'inference' }

const attachment = (id: string, serverId?: string): AgentChatAttachment => ({
  id, serverId, name: `${id}.png`, size: 100, type: 'image/png', lastModified: 0, available: true,
})

const sent = attachment('local-sent', 'server-sent')
const addedLater = attachment('local-later', 'server-later')
const notUploaded = attachment('local-only')

const sessionWithInput = (input: Partial<AgentInput> = {}): AgentChatSession => ({
  id: 'draft-1', createdAt: '2026-11-19T00:00:00Z', draft: ' 本轮消息 ',
  messages: [], attachments: [sent, addedLater, notUploaded], permissionMode: 'ask', modelId: null, reasoningLevel: null,
  remote: { sessionId: 'session-1', taskId: 'task-1', runId: 'run-1' },
  pending: { taskId: 'task-1', input: { requestId: 'request-2', content: '本轮消息', attachments: [{ id: 'server-sent' }], ...input } },
})

describe('聊天提交回执', () => {
  it.each([
    ['attachment-invalid', 400, true], ['queue-full', 429, true],
    ['queue-full', 500, false], ['unknown-rejection', 429, false],
    ['forbidden-origin', 403, false], ['request-conflict', 409, false],
  ])('业务拒绝 %s/%i 的结果确认判定为 %s', (code, status, expected) => {
    expect(isConfirmedRejection(new AgentHttpError('提交失败', code, status))).toBe(expected)
  })

  it('网络错误不证明服务端未受理', () => {
    expect(isConfirmedRejection(new Error('连接中断'))).toBe(false)
  })

  it('历史回执推进运行指针，不消耗另一条待确认输入', () => {
    const session = sessionWithInput()
    const { next, acceptedInput, consumedAttachmentIds } = applySubmissionReceipt(session, { ...run, id: 'older-run', requestId: 'older-request' })

    expect(next).toEqual({ ...session, remote: { sessionId: 'session-1', taskId: 'task-1', runId: 'older-run' } })
    expect(acceptedInput).toBeUndefined()
    expect(consumedAttachmentIds).toEqual([])
  })

  it.each([[' 本轮消息 ', ''], ['发送后写入的新草稿', '发送后写入的新草稿']])('普通发送只清匹配草稿与已发送附件：%s', (draft, remainingDraft) => {
    const session = { ...sessionWithInput(), draft }
    const original = structuredClone(session)
    const { next, acceptedInput, consumedAttachmentIds } = applySubmissionReceipt(session, run)

    expect(next).toMatchObject({ draft: remainingDraft, attachments: [addedLater, notUploaded], remote: { sessionId: 'session-1', taskId: 'task-1', runId: 'run-2' } })
    expect(next.pending).toBeUndefined()
    expect(acceptedInput).toEqual(original.pending?.input)
    expect(consumedAttachmentIds).toEqual(['local-sent'])
    expect(session).toEqual(original)
  })

  it('编辑重发只结清编辑，不清底部草稿和附件', () => {
    const session = { ...sessionWithInput({ replaceMessageId: 'message-1' }), editing: { messageId: 'message-1', taskId: 'task-1', text: '本轮消息' } }
    const { next, consumedAttachmentIds } = applySubmissionReceipt(session, { ...run, sessionId: 'receipt-session' })

    expect(next.editing).toBeUndefined()
    expect(next.pending).toBeUndefined()
    expect(next.remote?.sessionId).toBe('receipt-session')
    expect(next.draft).toBe(session.draft)
    expect(next.attachments).toEqual(session.attachments)
    expect(consumedAttachmentIds).toEqual([])
  })

  it('显式续接保留下方草稿，即使与提交文案相同', () => {
    const session = sessionWithInput({ continueFromRunId: 'run-1', attachments: undefined })
    const { next, consumedAttachmentIds } = applySubmissionReceipt(session, run)

    expect(next.pending).toBeUndefined()
    expect(next.draft).toBe(session.draft)
    expect(next.attachments).toEqual(session.attachments)
    expect(consumedAttachmentIds).toEqual([])
  })
})
