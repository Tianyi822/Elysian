/** 请求、会话和附件共用 UUID v4；普通 HTTP 的 IP 入口也保留安全随机性。 */
export function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* 原生快捷接口不可用时仍尝试安全随机字节。 */ }
  let bytes: Uint8Array
  try {
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') throw new Error()
    bytes = crypto.getRandomValues(new Uint8Array(16))
  } catch {
    throw new Error('当前浏览器无法生成安全请求标识，请更新浏览器后重试。')
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
