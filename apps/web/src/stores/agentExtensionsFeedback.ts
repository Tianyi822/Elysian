import { messageOf as errorMessageOf } from '../utils/errorMessage'
import { isDockerRuntime } from '../utils/isDockerRuntime'
import { demoNoticeSuffix } from '../utils/demoNotice'
import { useMessageStore } from './messageStore'

export const MOCK_SUFFIX = demoNoticeSuffix(isDockerRuntime())

export function messageOf(error: unknown): string {
  return errorMessageOf(error, '操作失败，请稍后重试')
}

export function notify(tone: 'success' | 'info' | 'danger', message: string): void {
  useMessageStore.getState().notify({ tone, message })
}
