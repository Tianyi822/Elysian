/**
 * 终端连接关闭码 → 界面错误消息的映射（终端消息协议「客户端错误映射」的唯一权威）：
 * 4000 空闲超时；1008 原样透传服务端中文 reason；1006 与其它一律按连接中断处理。
 * 映射逻辑不分域；「连接中断」的兜底措辞由调用方按域传入，缺省为本机终端文案。
 */
export function hostTerminalCloseMessage(
  code: number,
  reason: string,
  fallback = '本机终端连接中断',
): string {
  if (code === 4000) return '终端会话空闲超时，已断开'
  if (code === 1008) return reason.length > 0 ? reason : fallback
  return fallback
}
