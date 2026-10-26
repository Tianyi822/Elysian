/** 凭据与安全敏感取值只接受 WebCrypto；缺失时明确失败，不回退 Math.random。 */
function nextUint32(): number {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('当前浏览器无法生成安全随机数，请更新浏览器后重试。')
  }
  return crypto.getRandomValues(new Uint32Array(1))[0]!
}

/** 无取模偏差的 [0, maxExclusive) 整数；拒绝落在不可均分尾部的取值。 */
export function secureRandomInt(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x1_0000_0000) {
    throw new Error('安全随机取值范围无效')
  }
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive
  for (;;) {
    const value = nextUint32()
    if (value < limit) return value % maxExclusive
  }
}

export function secureRandomString(length: number, alphabet: string): string {
  if (!alphabet.length) throw new Error('安全随机字符表为空')
  let value = ''
  for (let index = 0; index < length; index += 1) {
    value += alphabet[secureRandomInt(alphabet.length)]!
  }
  return value
}
