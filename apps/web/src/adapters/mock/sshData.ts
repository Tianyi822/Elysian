import type {
  SshAuthSettings,
  SshKeyMaterial,
  SshLoginKey,
  SshLoginStats,
  SshOverview,
  SshPasswordResetResult,
  SshRootAuth,
  SshRootLoginPolicy,
} from '@elysian/contracts'
import { evaluateSshPasswordStrength } from '@elysian/contracts'

/*
 * SSH 演示数据集：本机 SSH 服务的开关与状态、登录统计、登录方式与监听端口、Root 登录策略与演示密钥，
 * 以及可自定义名称的登录密钥列表。
 * 种子值手工固定（统计与端口取真实运维样例的量级），确定性可复现；
 * 会话内的改动落在这份内存数据上，刷新回到种子状态。
 */

/** 种子统计：今日即参照产品的量级，昨日与近 7 天按同一比例铺开。 */
export const SEED_SSH_STATS: SshLoginStats = {
  today: { succeeded: 205, failed: 3147 },
  yesterday: { succeeded: 198, failed: 2890 },
  last7Days: { succeeded: 1382, failed: 18499 },
}

export const SEED_SSH_PORT = 73

export const SEED_SSH_ROOT_POLICY: SshRootLoginPolicy = 'prohibit-password'

/** base64 字母表：摘要按它映射，取字符的分布与真实指纹的正文一致。 */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 名称 → 43 字符的确定性摘要，形状与 SHA256 指纹的正文一致（不是真实哈希，只做占位）。 */
function keyDigest(name: string): string {
  const source = name || 'elysian'
  let seed = 0x811c9dc5
  const characters: string[] = []
  for (let index = 0; index < 43; index += 1) {
    seed = (seed ^ (source.charCodeAt(index % source.length) + index * 31)) >>> 0
    seed = Math.imul(seed, 0x01000193) >>> 0
    characters.push(BASE64_ALPHABET.charAt(seed % 64))
  }
  return characters.join('')
}

/**
 * 演示密钥材料的确定性派生：同一名称与生成时间永远得到同一份材料，测试与重放都可复现。
 * 材料是编造的占位文本，不对应任何真实主机，也解析不成可用密钥；界面整块标注「演示密钥」。
 */
export function mockKeyMaterial(name: string, createdAt: string): SshKeyMaterial {
  const digest = keyDigest(name)
  return {
    algorithm: 'ssh-ed25519 256',
    fingerprint: `SHA256:${digest}`,
    createdAt,
    publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${keyDigest(`${name}!public`).slice(0, 24)} ${name}@elysian-demo`,
    privateKey: [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
      digest,
      keyDigest(`${name}!body`),
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n'),
  }
}

/** 主机 root 账号那一把密钥；与用户自建的登录密钥分开管理。 */
const DEMO_ROOT_KEY = mockKeyMaterial('root', '2025-05-23T21:57:47')

function cloneStats(stats: SshLoginStats): SshLoginStats {
  return {
    today: { ...stats.today },
    yesterday: { ...stats.yesterday },
    last7Days: { ...stats.last7Days },
  }
}

/** 登录方式与端口的种子：密码登录默认关闭、密钥登录开启，端口沿用参照产品的 73。 */
const SEED_AUTH_SETTINGS: SshAuthSettings = {
  passwordAuthEnabled: false,
  keyAuthEnabled: true,
  port: SEED_SSH_PORT,
}

/** 登录密钥种子：四把按用途命名的密钥，材料由名称确定性派生。 */
export const SEED_LOGIN_KEYS: readonly SshLoginKey[] = [
  { id: 'key-部署机', name: '部署机', ...mockKeyMaterial('部署机', '2025-06-10T21:56:30') },
  { id: 'key-CI 发布', name: 'CI 发布', ...mockKeyMaterial('CI 发布', '2025-05-23T21:57:47') },
  { id: 'key-个人笔记本', name: '个人笔记本', ...mockKeyMaterial('个人笔记本', '2025-04-02T09:12:04') },
  { id: 'key-异地备份', name: '异地备份', ...mockKeyMaterial('异地备份', '2025-02-11T11:05:51') },
]

let overview: SshOverview
let settings: SshAuthSettings
let rootAuth: SshRootAuth
let keys: SshLoginKey[]

/** 把演示数据推回种子状态。演示数据只在内存里，「重置演示数据」与测试隔离都经这里。 */
export function resetSshData(): void {
  overview = {
    enabled: true,
    status: 'running',
    changedAt: null,
    stats: cloneStats(SEED_SSH_STATS),
  }
  settings = { ...SEED_AUTH_SETTINGS }
  rootAuth = { policy: SEED_SSH_ROOT_POLICY, key: { ...DEMO_ROOT_KEY }, passwordResetAt: null }
  keys = SEED_LOGIN_KEYS.map((key) => ({ ...key }))
}

resetSshData()

export function getSshOverview(): SshOverview {
  return { ...overview, stats: cloneStats(overview.stats) }
}

export function setSshServiceEnabled(enabled: boolean, changedAt: string): SshOverview {
  overview = { ...overview, enabled, status: enabled ? 'running' : 'stopped', changedAt }
  return getSshOverview()
}

export function getSshAuthSettings(): SshAuthSettings {
  return { ...settings }
}

export function saveSshAuthSettings(next: SshAuthSettings): SshAuthSettings {
  settings = { ...next }
  return { ...settings }
}

export function getSshRootAuth(): SshRootAuth {
  return { ...rootAuth, key: { ...rootAuth.key } }
}

export function saveSshRootLoginPolicy(policy: SshRootLoginPolicy): SshRootAuth {
  rootAuth = { ...rootAuth, policy }
  return getSshRootAuth()
}

/** 重置 Root 密码：判定为弱密码即拒绝，判定规则与界面上的即时强度反馈同源。 */
export function resetSshRootPassword(password: string, resetAt: string): SshPasswordResetResult {
  const strength = evaluateSshPasswordStrength(password)
  if (strength === 'weak') {
    throw new Error('密码强度不足：判定为弱密码，请加长密码并混合大小写字母、数字与符号')
  }
  rootAuth = { ...rootAuth, passwordResetAt: resetAt }
  return { auth: getSshRootAuth(), strength }
}

export function getSshLoginKeys(): readonly SshLoginKey[] {
  return keys.map((key) => ({ ...key }))
}

export function findSshLoginKeyByName(name: string): SshLoginKey | undefined {
  return keys.find((key) => key.name === name)
}

/** 新增登录密钥：材料按名称确定性派生，同一名称总是得到同一份材料。 */
export function addSshLoginKey(name: string, createdAt: string): SshLoginKey {
  const key: SshLoginKey = { id: `key-${name}`, name, ...mockKeyMaterial(name, createdAt) }
  keys = [...keys, key]
  return { ...key }
}

export function removeSshLoginKey(keyId: string): void {
  const existing = keys.find((key) => key.id === keyId)
  if (!existing) throw new Error(`未找到登录密钥 ${keyId}`)
  keys = keys.filter((key) => key.id !== keyId)
}
