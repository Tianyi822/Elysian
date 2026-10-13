import type { AgentChatOutput, AgentCreateSessionInput, AgentInput, AgentMessage, AgentSession, AgentSwitchModelInput, RuntimeRun } from '@elysian/contracts'

/** 权限选项保留为界面草稿，不授予后端权限。 */
export type AgentChatPermissionMode = 'ask' | 'assist' | 'full'

export type AgentChatAttachment = {
  id: string
  name: string
  size: number
  type: string
  lastModified: number
  /** 文件字节仍可从当前浏览器读取；恢复失败时保留文件名，并明确标为不可用。 */
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
  /** 未收到明确回执时保留精确输入，人工确认沿用同一 requestId。 */
  pending?: { input: AgentInput; taskId?: string }
}

export type AgentChatRun = Pick<RuntimeRun, 'id' | 'requestId' | 'sessionId' | 'taskId' | 'status' | 'phase' | 'cancelRequestedAt' | 'error' | 'warning'>
export type AgentChatPageResult<T> = { items: readonly T[]; nextCursor: string; hasMore: boolean }
export type AgentChatTask = { id: string; sessionId: string; kind: string; latestRun?: AgentChatRun }
export const agentChatSessionKey = (session: AgentChatSession) => session.remote?.sessionId ?? session.id

export interface AgentConversationAdapter {
  readonly available: boolean
  listSessions(cursor?: string, signal?: AbortSignal): Promise<AgentChatPageResult<AgentSession>>
  listTasks(sessionId: string, cursor?: string, signal?: AbortSignal): Promise<AgentChatPageResult<AgentChatTask>>
  getTask(id: string, signal?: AbortSignal): Promise<AgentChatTask>
  createSession(input: AgentCreateSessionInput): Promise<AgentSession>
  getSession(id: string, signal?: AbortSignal): Promise<AgentSession>
  switchModel(id: string, input: AgentSwitchModelInput): Promise<AgentSession>
  messages(id: string, after: string, signal?: AbortSignal): Promise<{ items: readonly AgentMessage[]; nextCursor: string; hasMore: boolean }>
  createTask(sessionId: string, input: AgentInput): Promise<AgentChatRun>
  continueTask(taskId: string, input: AgentInput): Promise<AgentChatRun>
  getRun(id: string, signal?: AbortSignal): Promise<AgentChatRun>
  /** 仅返回本轮推理请求明确提供的思考文本或公开摘要。 */
  reasoning(id: string, signal?: AbortSignal): Promise<string>
  stream(id: string, onOutput: (output: AgentChatOutput) => void, signal: AbortSignal): Promise<void>
}

export interface AgentChatAdapter {
  read(key?: string): AgentChatSession | null
  list(): AgentChatSession[]
  select(key: string): boolean
  /** 返回是否已持久化；浏览器拒绝存储时仍可在本页继续编辑。 */
  write(session: AgentChatSession, select?: boolean): boolean
  subscribe(listener: () => void): () => void
  attach(files: readonly File[]): Promise<{ attachments: AgentChatAttachment[]; persisted: boolean }>
  restore(attachments: readonly AgentChatAttachment[]): Promise<AgentChatAttachment[]>
  discard(ids: readonly string[]): Promise<void>
}
