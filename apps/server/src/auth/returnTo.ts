import { ALLOWED_HOSTNAMES } from '../shared/allowedHostnames.ts'
import { RETURN_TO_MAX_LENGTH } from './authConfig.ts'

/*
 * 单点登录的回跳裁决：只认「origin 精确落在允许名单里」的绝对 http/https 地址。
 * 通过回规范化 href，任何一条不过回 null——调用方据此决定跳外站还是留在站内，
 * 安全判定全部在此，不在浏览器侧。
 *
 * 返回 href 而非原串：WHATWG 归一化（反斜杠转斜杠、协议与主机小写化）只发生一次，
 * 裁决所见即浏览器所去，不存在「判的是一套、跳的是另一套」的窗口。
 */

/** 解析绝对 URL；相对地址与协议相对形（`//host/path`）无基地址时抛错，视为不可用。 */
function parseAbsolute(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

export function adjudicateReturnTo(raw: string | null | undefined, allowed: readonly string[]): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > RETURN_TO_MAX_LENGTH) return null
  const url = parseAbsolute(trimmed)
  if (url === null) return null
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!allowed.includes(url.origin)) return null
  // 纵深：名单被人写成外部域名时仍然跳不出去。returnOriginRegistry 写入侧按同一条校验。
  if (!ALLOWED_HOSTNAMES.includes(url.hostname)) return null
  return url.href
}
