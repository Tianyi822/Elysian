import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

/*
 * 密码哈希：node:crypto 的 scrypt + timingSafeEqual。选 node:crypto 而不是
 * Bun.password 的理由是它在 Bun 与 Node 上是同一实现，可静态进入 vitest 的 node
 * 模块图（Bun.password 是 bun 专属 API，会逼出双实现或 .bun.test.ts 双轨）。
 *
 * 格式串 `scrypt:N:r:p:<saltBase64>:<hashBase64>`：参数随哈希一起落盘，verify 时
 * 按串内参数派生——将来调整参数只影响新哈希，旧哈希仍然可验。
 *
 * verify 对格式非法的 stored 一律回 false、绝不抛错：凭据文件被写坏时登录恒拒绝
 * （fail closed），而不是 500。
 */

/** 派生参数：N=16384、r=8、p=1（OWASP 2023 对交互式登录的推荐档），派生键 32 字节。 */
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEY_LENGTH = 32
const SALT_LENGTH = 16

export interface PasswordHasher {
  hash(plain: string): Promise<string>
  /** 恒定时间比较；stored 格式非法一律回 false，绝不抛错。 */
  verify(plain: string, stored: string): Promise<boolean>
}

function scrypt(plain: string, salt: Buffer, params: { N: number; r: number; p: number }, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(plain, salt, keyLength, { N: params.N, r: params.r, p: params.p }, (error, derived) => {
      if (error) reject(error)
      else resolve(derived)
    })
  })
}

type StoredHash = { params: { N: number; r: number; p: number }; salt: Buffer; hash: Buffer }

/** 解析格式串；任何一段不合法都回 null（verify 据此回 false，不抛错）。 */
function parseStored(stored: string): StoredHash | null {
  const parts = stored.split(':')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null
  if (N <= 0 || r <= 0 || p <= 0 || N * r * p > 2 ** 30) return null
  let salt: Buffer
  let hash: Buffer
  try {
    const saltText = parts[4]
    const hashText = parts[5]
    if (saltText === undefined || hashText === undefined) return null
    salt = Buffer.from(saltText, 'base64')
    hash = Buffer.from(hashText, 'base64')
  } catch {
    return null
  }
  if (salt.length === 0 || hash.length === 0) return null
  return { params: { N, r, p }, salt, hash }
}

export function createScryptHasher(): PasswordHasher {
  return {
    async hash(plain: string): Promise<string> {
      const salt = randomBytes(SALT_LENGTH)
      const derived = await scrypt(plain, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, SCRYPT_KEY_LENGTH)
      return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${derived.toString('base64')}`
    },
    async verify(plain: string, stored: string): Promise<boolean> {
      const parsed = parseStored(stored)
      if (parsed === null) return false
      const derived = await scrypt(plain, parsed.salt, parsed.params, parsed.hash.length)
      return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash)
    },
  }
}
