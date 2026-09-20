import type {
  SshAuthSettings,
  SshKeyMaterial,
  SshLoginKey,
  SshLoginRecord,
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

/** 登录密钥种子：前四把按用途手写，其余补齐到两页——表格每页 20 条，分页才不是摆设。 */
const HAND_WRITTEN_KEYS: readonly { name: string; userId: string; createdAt: string }[] = [
  { name: '部署机', userId: 'user-wangwu', createdAt: '2025-06-10T21:56:30' },
  { name: 'CI 发布', userId: 'user-ops', createdAt: '2025-05-23T21:57:47' },
  { name: '个人笔记本', userId: 'user-lisi', createdAt: '2025-04-02T09:12:04' },
  { name: '异地备份', userId: 'user-backup', createdAt: '2025-02-11T11:05:51' },
]

/** 补齐用的临时密钥：时间在最早那把之前按固定间隔往前推，材料仍由名称确定性派生。 */
const TEMPORARY_KEY_COUNT = 18

/** 临时密钥轮流归属几个常用账号，列表里因此能看到不同账号下的密钥。 */
const TEMPORARY_KEY_OWNERS = ['user-wangwu', 'user-ops', 'user-lisi']

export const SEED_LOGIN_KEYS: readonly SshLoginKey[] = [
  ...HAND_WRITTEN_KEYS.map(({ name, userId, createdAt }) => ({
    id: `key-${name}`,
    name,
    userId,
    ...mockKeyMaterial(name, createdAt),
  })),
  ...Array.from({ length: TEMPORARY_KEY_COUNT }, (_, index) => {
    const step = index + 1
    const name = `临时密钥 ${`${step}`.padStart(2, '0')}`
    const createdAt = new Date(
      Date.parse('2025-02-11T11:05:51+08:00') - step * 26 * 60 * 60_000,
    ).toISOString()
    return {
      id: `key-${name}`,
      name,
      userId: TEMPORARY_KEY_OWNERS[index % TEMPORARY_KEY_OWNERS.length] ?? 'user-wangwu',
      ...mockKeyMaterial(name, createdAt),
    }
  }),
]

/*
 * 登录记录种子：前六条按样例手写（来源地址与时间取自真实运维样例，末尾一条是失败记录——
 * 状态列有两种取值，只摆成功记录会让那一列没有意义），其余按固定间隔往前推，补齐到两页。
 * 时间写全带时区的 ISO，格式化按固定时区渲染，测试因此在任何机器上都得到同一串结果。
 */
const HAND_WRITTEN_RECORDS: readonly Omit<SshLoginRecord, 'id'>[] = [
  { ip: '1.204.32.143', port: 16999, at: '2026-09-07T14:10:53+08:00', user: 'root', result: 'succeeded' },
  { ip: '114.139.238.201', port: 18569, at: '2025-05-24T23:38:30+08:00', user: 'root', result: 'succeeded' },
  { ip: '114.139.238.201', port: 21257, at: '2025-05-24T20:48:08+08:00', user: 'root', result: 'succeeded' },
  { ip: '127.0.0.1', port: 43462, at: '2025-05-24T19:28:45+08:00', user: 'root', result: 'succeeded' },
  { ip: '114.139.238.201', port: 17964, at: '2025-05-24T18:56:30+08:00', user: 'root', result: 'succeeded' },
  { ip: '45.155.205.233', port: 51422, at: '2025-05-24T03:12:07+08:00', user: 'root', result: 'failed' },
]

/** 补齐记录用的来源地址池：真实爆破扫描的常见来源形态，轮换出现。 */
const LOGIN_SOURCE_IPS = ['114.139.238.201', '45.155.205.233', '1.204.32.143', '127.0.0.1']

const EXTRA_RECORD_COUNT = 20

export const SEED_LOGIN_RECORDS: readonly SshLoginRecord[] = [
  ...HAND_WRITTEN_RECORDS.map((record, index) => ({ id: `login-${index + 1}`, ...record })),
  ...Array.from({ length: EXTRA_RECORD_COUNT }, (_, index) => {
    const step = index + 1
    // 从最早那条手写记录继续往前推，整张表因此始终是时间倒序。
    const at = new Date(
      Date.parse('2025-05-24T03:12:07+08:00') - step * 37 * 60_000,
    ).toISOString()
    return {
      id: `login-${HAND_WRITTEN_RECORDS.length + step}`,
      ip: LOGIN_SOURCE_IPS[step % LOGIN_SOURCE_IPS.length] ?? '127.0.0.1',
      port: 40000 + step * 137,
      at,
      user: 'root',
      // 每七条掺一次失败尝试：连续成功的日志不真实，也不便于核对状态列。
      result: step % 7 === 0 ? 'failed' : 'succeeded',
    } satisfies SshLoginRecord
  }),
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
  // mock 种子里 Root 密钥始终存在；真实实现里 authorized_keys 为空时 key 为 null。
  return rootAuth.key === null ? rootAuth : { ...rootAuth, key: { ...rootAuth.key } }
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

export function getSshLoginRecords(): readonly SshLoginRecord[] {
  return SEED_LOGIN_RECORDS.map((record) => ({ ...record }))
}

export function findSshLoginKeyByName(name: string): SshLoginKey | undefined {
  return keys.find((key) => key.name === name)
}

/** 新增登录密钥：材料按名称确定性派生，同一名称总是得到同一份材料。 */
export function addSshLoginKey(name: string, userId: string, createdAt: string): SshLoginKey {
  const key: SshLoginKey = {
    id: `key-${name}`,
    name,
    userId,
    ...mockKeyMaterial(name, createdAt),
  }
  keys = [...keys, key]
  return { ...key }
}

export function removeSshLoginKey(keyId: string): void {
  const existing = keys.find((key) => key.id === keyId)
  if (!existing) throw new Error(`未找到登录密钥 ${keyId}`)
  keys = keys.filter((key) => key.id !== keyId)
}

/**
 * 账号被删除时，它的密钥一并失效：真实系统里 `userdel -r` 连同家目录里的 authorized_keys 一起删掉，
 * 授权没了、私钥也就登不进来。
 */
export function removeSshLoginKeysByUser(userId: string): number {
  const before = keys.length
  keys = keys.filter((key) => key.userId !== userId)
  return before - keys.length
}
