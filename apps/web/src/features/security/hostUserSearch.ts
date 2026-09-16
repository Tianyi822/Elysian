import type { HostUser } from '@elysian/contracts'

/*
 * 账号搜索：用户名与备注两处参与匹配，与密钥表的搜索同一套归一化口径
 * ——去掉全部空白并统一小写，粘带空格的备注或大小写不一致的用户名都能命中。
 */

export function normalizeUserSearch(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

export function matchesHostUser(keyword: string, user: HostUser): boolean {
  const needle = normalizeUserSearch(keyword)
  if (!needle) return true
  return [user.name, user.note ?? ''].some((field) =>
    normalizeUserSearch(field).includes(needle),
  )
}

/** 空关键词返回原列表：清空搜索框即回到全部账号。 */
export function filterHostUsers(
  keyword: string,
  users: readonly HostUser[],
): readonly HostUser[] {
  if (!normalizeUserSearch(keyword)) return users
  return users.filter((user) => matchesHostUser(keyword, user))
}
