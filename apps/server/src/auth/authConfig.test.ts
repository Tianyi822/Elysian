import { describe, expect, it } from 'vitest'
import { AUTH_EXEMPT_PATHS, isCookieSecureEnabled, isDevAccountEnabled } from './authConfig.ts'
import { isAuthExemptPath, parseSessionCookie } from './authMiddleware.ts'

/*
 * 鉴权常量与环境开关的小单测：开关只认字面 '1'（缺省与他值恒关）、豁免判定剥单个
 * 尾斜杠、Cookie 解析不引依赖。
 */

describe('环境开关', () => {
  it('isDevAccountEnabled：仅 ELYSIAN_AUTH_DEV 严格等于 "1" 才开', () => {
    expect(isDevAccountEnabled({})).toBe(false)
    expect(isDevAccountEnabled({ ELYSIAN_AUTH_DEV: '0' })).toBe(false)
    expect(isDevAccountEnabled({ ELYSIAN_AUTH_DEV: 'true' })).toBe(false)
    expect(isDevAccountEnabled({ ELYSIAN_AUTH_DEV: '1' })).toBe(true)
  })

  it('isCookieSecureEnabled：仅 ELYSIAN_COOKIE_SECURE 严格等于 "1" 才开', () => {
    expect(isCookieSecureEnabled({})).toBe(false)
    expect(isCookieSecureEnabled({ ELYSIAN_COOKIE_SECURE: '0' })).toBe(false)
    expect(isCookieSecureEnabled({ ELYSIAN_COOKIE_SECURE: '1' })).toBe(true)
  })
})

describe('isAuthExemptPath', () => {
  it('四条豁免路径精确匹配，尾斜杠先剥单个', () => {
    for (const path of AUTH_EXEMPT_PATHS) {
      expect(isAuthExemptPath(path)).toBe(true)
      expect(isAuthExemptPath(`${path}/`)).toBe(true)
    }
    // 豁免之外一律不放行：包括近形路径与更深子路径。
    for (const path of ['/api/healthx', '/api/auth/loginx', '/api/auth/login//', '/api/auth/logins', '/api/platform/memory', '/api/platform/dependencies', '/api/logs/runtime', '/api/auth']) {
      expect(isAuthExemptPath(path), path).toBe(false)
    }
  })
})

describe('parseSessionCookie', () => {
  it('按 ; 分段找到会话 id；空值、缺键、无头都回 null', () => {
    expect(parseSessionCookie('elysian_session=abc123')).toBe('abc123')
    expect(parseSessionCookie('other=1; elysian_session=abc123; more=2')).toBe('abc123')
    expect(parseSessionCookie('elysian_session=')).toBeNull()
    expect(parseSessionCookie('other=1')).toBeNull()
    expect(parseSessionCookie('')).toBeNull()
    expect(parseSessionCookie(null)).toBeNull()
    expect(parseSessionCookie(undefined)).toBeNull()
  })

  it('多条同名 Cookie 取最后一个匹配：更深层 Path 植入的首条无法遮蔽面板真会话', () => {
    // 浏览器按 path 长度降序回送同名 Cookie，面板自身 Path=/ 的 Cookie 恒排同名
    // 最后，取末个匹配即免疫更深层植入的遮蔽。
    expect(parseSessionCookie('elysian_session=attacker; other=1; elysian_session=real')).toBe('real')
    // 末条命中为空串时维持既有语义：回 null。
    expect(parseSessionCookie('elysian_session=real; elysian_session=')).toBeNull()
  })
})
