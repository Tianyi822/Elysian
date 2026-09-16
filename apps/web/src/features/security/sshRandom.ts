/*
 * 演示用的取值生成：随机端口与随机强密码。
 * 都只用于「填出候选值」——端口保存前仍走 isValidSshPort 校验，
 * 密码重置前仍走 evaluateSshPasswordStrength 判定，生成结果不构成任何豁免。
 * 这里不放进契约包：契约只放与传输无关的确定性纯函数。
 */

/** 随机端口的取值范围从 1024 起：避开特权端口，免得生成一个内核层就用不了的选值。 */
const RANDOM_PORT_MIN = 1024
const RANDOM_PORT_MAX = 65535

/** 字母表去掉了易混字符（l、I、O、0、1），生成的口令要能照着念、照着敲。 */
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const SYMBOLS = '!@#$%^&*-_=+'

/** 随机端口，落在 1024-65535。 */
export function randomSshPort(): number {
  return RANDOM_PORT_MIN + Math.floor(Math.random() * (RANDOM_PORT_MAX - RANDOM_PORT_MIN + 1))
}

/**
 * 随机生成一个必然判定为强的密码：四类字符各取一枚打底，补足长度后打乱。
 * 打底保证了类别数，长度保证了判定结果落在「强」一档。
 */
export function randomStrongPassword(length = 20): string {
  const pool = LOWER + UPPER + DIGITS + SYMBOLS
  const seed = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)]
  const rest = Array.from({ length: Math.max(0, length - seed.length) }, () => pick(pool))
  return shuffle([...seed, ...rest]).join('')
}

function pick(source: string): string {
  return source.charAt(Math.floor(Math.random() * source.length))
}

function shuffle(chars: readonly string[]): string[] {
  const remaining = [...chars]
  const result: string[] = []
  while (remaining.length > 0) {
    const [char] = remaining.splice(Math.floor(Math.random() * remaining.length), 1)
    if (char !== undefined) result.push(char)
  }
  return result
}
