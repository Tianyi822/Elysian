import { useMessageStore } from '../stores/messageStore'

/** 业务测试验证发布结果；消息浮层的呈现与焦点由 MessageCenter 测试覆盖。 */
export function messageHistoryText(kind?: 'status' | 'alert'): string {
  return useMessageStore.getState().messages
    .filter(message => !kind || (kind === 'alert' ? message.tone === 'danger' : message.tone !== 'danger'))
    .map(message => message.message).join('\n')
}
