import type { AgentApproval, AgentAttachmentRef, AgentChatOutput, AgentChatTimelineSnapshot, AgentCreateSessionInput, AgentInput, AgentMessage, AgentMessageAttachment, AgentPermissionMode, AgentRenameSessionInput, AgentSession, AgentSwitchModelInput, RuntimeCall, RuntimeRun } from '@elysian/contracts'
import type { AgentUserInputAnswer, AgentUserInputRequest, AgentUserInputSubmission } from '@elysian/contracts'
import type { AgentAccessDecisionInput, AgentAuthorizationRevokeInput, AgentSessionAuthorization } from '@elysian/contracts'

export type AgentChatPermissionMode = AgentPermissionMode

export type AgentChatAttachment = {
  id: string
  name: string
  size: number
  type: string
  lastModified: number
  /** 发送能力的权威：存在 serverId 即已上传可随消息发送，与本地字节是否可用正交。 */
  serverId?: string
  width?: number
  height?: number
  /** 本地文件字节仍可从当前浏览器读取；为 false 只影响预览，不影响可发送性。 */
  available: boolean
  previewUrl?: string
}

export type AgentChatMessage = {
  id: string
  role: 'user'
  text: string
  createdAt: string
  attachments: AgentChatAttachment[]
  permissionMode: AgentChatPermissionMode
  modelId: string | null
  reasoningLevel: string | null
}

export type AgentChatSession = {
  userInput?: { id: string; runId: string; answers: Readonly<Record<string, AgentUserInputAnswer>>; pending?: AgentUserInputSubmission }
  /** 已迁离旧预览偏好，后续选择随每轮输入提交。 */
  permissionVersion?: 1
  id: string
  createdAt: string
  draft: string
  messages: AgentChatMessage[]
  attachments: AgentChatAttachment[]
  permissionMode: AgentChatPermissionMode
  modelId: string | null
  reasoningLevel: string | null
  /** 浏览器只保存服务端指针；真实消息由 API 回读。 */
  remote?: { sessionId: string; taskId?: string; runId?: string }
  /** 编辑只改文本；超限旧图在提交前另存新附件，原历史和未确认请求不改。 */
  editing?: {
    messageId: string
    taskId: string
    text: string
    attachments?: readonly AgentAttachmentRef[]
    preparedAttachments?: readonly { sourceId: string; attachment: AgentChatAttachment }[]
  }
  /** 未收到明确回执时保留精确输入，人工确认沿用同一 requestId。 */
  pending?: { input: AgentInput; taskId?: string }
}

export type AgentChatRun = Pick<RuntimeRun, 'id' | 'requestId' | 'sessionId' | 'taskId' | 'status' | 'phase' | 'cancelRequestedAt' | 'error' | 'warning' | 'plan'>
export type AgentChatPageResult<T> = { items: readonly T[]; nextCursor: string; hasMore: boolean }
export type AgentChatTask = { id: string; sessionId: string; kind: string; latestRun?: AgentChatRun }
export const agentChatSessionKey = (session: AgentChatSession) => session.remote?.sessionId ?? session.id
/** 会话在浏览器侧登记的全部附件：会话级附件与各消息附件的合集，删除会话时按此清字节。 */
export const agentChatAllAttachments = (session: AgentChatSession): readonly AgentChatAttachment[] =>
  [...session.attachments, ...session.messages.flatMap(message => message.attachments),
    ...(session.editing?.preparedAttachments?.map(item => item.attachment) ?? [])]

/** 上传回执：服务端按魔数判定 MIME 并返回描述符，id 即随消息提交的引用。 */
export type AgentChatUploadedAttachment = AgentMessageAttachment & { createdAt?: string }

export interface AgentConversationAdapter {
  answerUserInput(runId: string, inputId: string, input: AgentUserInputSubmission): Promise<{ userInput: AgentUserInputRequest; run: AgentChatRun }>
  readonly governance?: AgentChatGovernance
  readonly available: boolean
  listSessions(cursor?: string, signal?: AbortSignal): Promise<AgentChatPageResult<AgentSession>>
  listTasks(sessionId: string, cursor?: string, signal?: AbortSignal): Promise<AgentChatPageResult<AgentChatTask>>
  getTask(id: string, signal?: AbortSignal): Promise<AgentChatTask>
  createSession(input: AgentCreateSessionInput): Promise<AgentSession>
  getSession(id: string, signal?: AbortSignal): Promise<AgentSession>
  renameSession(id: string, input: AgentRenameSessionInput): Promise<AgentSession>
  deleteSession(id: string): Promise<void>
  switchModel(id: string, input: AgentSwitchModelInput): Promise<AgentSession>
  messages(id: string, after: string, signal?: AbortSignal): Promise<{ items: readonly AgentMessage[]; nextCursor: string; hasMore: boolean }>
  timeline(id: string, signal?: AbortSignal): Promise<AgentChatTimelineSnapshot>
  calls(id: string, signal?: AbortSignal): Promise<readonly RuntimeCall[]>
  /** 按序逐张 multipart 上传，每个请求一个名为 file 的 part；全部成功后返回整组回执。 */
  uploadAttachments(files: readonly File[], signal?: AbortSignal): Promise<{ items: readonly AgentChatUploadedAttachment[] }>
  /** 按附件 id 读取已上传图片字节，用于历史消息缩略图。 */
  attachmentBlob(id: string, signal?: AbortSignal): Promise<Blob>
  createTask(sessionId: string, input: AgentInput): Promise<AgentChatRun>
  continueTask(taskId: string, input: AgentInput): Promise<AgentChatRun>
  getRun(id: string, signal?: AbortSignal): Promise<AgentChatRun>
  cancelRun(id: string): Promise<AgentChatRun>
  /** 仅返回本轮推理请求明确提供的思考文本或公开摘要。 */
  reasoning(id: string, signal?: AbortSignal): Promise<string>
  stream(id: string, onOutput: (output: AgentChatOutput) => void, signal: AbortSignal): Promise<void>
}

export interface AgentChatGovernance {
  decideAccess(id: string, input: AgentAccessDecisionInput): Promise<AgentApproval>
  authorizations(sessionId: string, signal?: AbortSignal): Promise<readonly AgentSessionAuthorization[]>
  revokeAuthorization(sessionId: string, id: string, input: AgentAuthorizationRevokeInput): Promise<AgentSessionAuthorization>
  approvals(runId: string, signal?: AbortSignal): Promise<readonly AgentApproval[]>
  decide(id: string, decision: 'approved' | 'denied'): Promise<AgentApproval>
}

export interface AgentChatAdapter {
  read(key?: string): AgentChatSession | null
  list(): AgentChatSession[]
  select(key: string): boolean
  /** 返回是否已持久化；浏览器拒绝存储时仍可在本页继续编辑。 */
  write(session: AgentChatSession, select?: boolean): boolean
  /** 删除一条本地会话记录：清记录键、附件字节与指向它的选中指针。 */
  remove(key: string): void
  subscribe(listener: () => void): () => void
  attach(files: readonly File[]): Promise<{ attachments: AgentChatAttachment[]; persisted: boolean }>
  restore(attachments: readonly AgentChatAttachment[]): Promise<AgentChatAttachment[]>
  discard(ids: readonly string[]): Promise<void>
}
