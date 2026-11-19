import type { AgentChatRun, AgentChatSession } from '../contracts/agentChat'
import { AgentHttpError } from '../contracts/agentHttpError'

// 这些业务拒绝发生在 submitAgent 核对 requestId 之后，可确认该请求未被接受。
// 前置来源/请求体守卫、未知 4xx 与请求标识冲突都不能证明先前的未确认请求未执行。
const confirmedRejections: Readonly<Record<string, number>> = {
  'invalid-task': 400, 'model-capability': 400, 'unsupported-reasoning-level': 400,
  'session-not-found': 404, 'task-not-found': 404, 'profile-not-found': 404, 'profile-revision-not-found': 404,
  'session-busy': 409, 'model-changed': 409, 'profile-inactive': 409, 'queue-full': 429,
  'invalid-replacement': 400, 'message-changed': 409, 'continuation-changed': 409, 'continuation-blocked': 409,
  'image-unsupported': 400, 'attachment-invalid': 400, 'attachment-too-many': 400, 'attachment-too-large': 400, 'attachment-message-too-large': 400,
}

export const isConfirmedRejection = (error: unknown) => error instanceof AgentHttpError &&
  !!error.code && Object.hasOwn(confirmedRejections, error.code) && confirmedRejections[error.code] === error.status

export function applySubmissionReceipt(session: AgentChatSession, run: AgentChatRun) {
  const pendingInput = session.pending?.input
  const acceptedInput = pendingInput?.requestId === run.requestId ? pendingInput : undefined
  const next: AgentChatSession = {
    ...session,
    remote: { sessionId: run.sessionId ?? session.remote!.sessionId, taskId: run.taskId, runId: run.id },
    ...(acceptedInput ? {
      pending: undefined,
      ...(acceptedInput.replaceMessageId ? { editing: undefined }
        : !acceptedInput.continueFromRunId && session.draft.trim() === acceptedInput.content ? { draft: '' } : {}),
    } : {}),
  }
  const consumedAttachmentIds: string[] = []
  // 待确认期间新增的附件不属于本次发送，保留给用户后续处置。
  if (acceptedInput && !acceptedInput.replaceMessageId && acceptedInput.attachments?.length && session.attachments.length) {
    const sent = new Set(acceptedInput.attachments.map(ref => ref.id))
    const remaining = session.attachments.filter(attachment => {
      if (!attachment.serverId || !sent.has(attachment.serverId)) return true
      consumedAttachmentIds.push(attachment.id)
      return false
    })
    if (consumedAttachmentIds.length) next.attachments = remaining
  }
  return { next, acceptedInput, consumedAttachmentIds }
}
