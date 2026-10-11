/** 保留 HTTP 状态，冲突可以重新核对；网络故障和超时不可自动重传。 */
export class FileTransferError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'FileTransferError'
  }
}

export function isFileUploadConflict(error: unknown): boolean {
  return error instanceof FileTransferError && error.status === 409
}
