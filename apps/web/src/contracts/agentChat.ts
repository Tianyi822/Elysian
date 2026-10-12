/** 智能体会话的前端预览模型；不表示后端 Run 或审批授权。 */
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
}

export interface AgentChatAdapter {
  read(): AgentChatSession | null
  /** 返回是否已持久化；浏览器拒绝存储时仍可在本页继续编辑。 */
  write(session: AgentChatSession): boolean
  subscribe(listener: () => void): () => void
  attach(files: readonly File[]): Promise<{ attachments: AgentChatAttachment[]; persisted: boolean }>
  restore(attachments: readonly AgentChatAttachment[]): Promise<AgentChatAttachment[]>
  discard(ids: readonly string[]): Promise<void>
}
