/** 服务端 {error,code} 的透传错误：message 为中文 error，code 保留机器判定用。 */
export class AgentHttpError extends Error {
  readonly code?: string
  readonly status?: number
  constructor(message: string, code?: string, status?: number) {
    super(message)
    this.name = 'AgentHttpError'
    this.code = code
    this.status = status
  }
}
