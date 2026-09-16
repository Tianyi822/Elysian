import type { SshLoginKey } from '@elysian/contracts'

/*
 * 密钥搜索：名称、指纹与私钥内容三处都参与匹配，也就是用户手上能拿到的三样东西。
 * 公钥在创建时就留在本机授权文件里，界面不展示，因此不参与匹配。
 *
 * 比对前两侧都去掉全部空白并统一小写：密钥正文本身不含空白，
 * 而把一整份私钥文件粘进单行输入框时，换行会被输入框吞掉或折成空格——
 * 去掉空白后两种情况都能命中，用户不必先把密钥整理成一行。
 */

export function normalizeKeySearch(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

export function matchesSshKey(keyword: string, key: SshLoginKey): boolean {
  const needle = normalizeKeySearch(keyword)
  if (!needle) return true
  return [key.name, key.fingerprint, key.privateKey].some((field) =>
    normalizeKeySearch(field).includes(needle),
  )
}

/** 空关键词返回原列表：清空搜索框即回到全部密钥。 */
export function filterSshKeys(
  keyword: string,
  keys: readonly SshLoginKey[],
): readonly SshLoginKey[] {
  if (!normalizeKeySearch(keyword)) return keys
  return keys.filter((key) => matchesSshKey(keyword, key))
}
