import type { SshKeyAccount } from '../../contracts/adapters'

/*
 * authorized_keys 的定位与行级编辑：路径只从服务端的 getent passwd 推导，
 * 绝不接受客户端传来的路径；行级增删按「整行精确匹配」进行，公钥行经
 * ssh-keygen -lf 验证合法后才落盘（验证由 service 注入的 runSshKeygen 执行，
 * 这里只负责纯文本部分与 -lf 输出的解析）。
 */

/** getent passwd 的一行：name:passwd:uid:gid:gecos:home:shell。 */
export type PasswdEntry = {
  name: string
  uid: number
  home: string
  shell: string
}

/** 解析单行；字段不足或 uid 非数字时返回 null。 */
export function parsePasswdLine(line: string): PasswdEntry | null {
  const fields = line.trim().split(':')
  if (fields.length < 7) return null
  const [name, , uidText, , , home, shell] = fields
  const uid = Number.parseInt(uidText ?? '', 10)
  if (!name || !home || !shell || !Number.isInteger(uid)) return null
  return { name, uid, home, shell }
}

/** 解析 getent passwd 的多行输出，跳过无法辨认的行。 */
export function parseGetentPasswd(output: string): readonly PasswdEntry[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parsePasswdLine)
    .filter((entry): entry is PasswdEntry => entry !== null)
}

/** 无登录能力的 shell：nologin 与 false 都无法承载交互登录。 */
function isLoginShell(shell: string): boolean {
  const base = shell.split('/').pop() ?? shell
  return base !== 'nologin' && base !== 'false'
}

/**
 * 账号是否可归属密钥：uid≥1000 且有登录 shell，root 除外——
 * Root 的密钥由 Root 密钥卡单独管理，不混进登录密钥的归属清单。
 */
export function isKeyAccount(entry: { name: string; uid: number; shell: string }): boolean {
  return entry.name !== 'root' && entry.uid >= 1000 && isLoginShell(entry.shell)
}

/** 密钥可归属的真实系统账号清单（见 isKeyAccount）。 */
export function listKeyAccounts(passwdOutput: string): readonly SshKeyAccount[] {
  return parseGetentPasswd(passwdOutput)
    .filter(isKeyAccount)
    .map((entry) => ({ id: entry.name, name: entry.name }))
}

/** 账号主目录下的 .ssh 目录路径；只由服务端拼接，客户端无从注入。 */
export function sshDirPath(homeDir: string): string {
  return `${homeDir.replace(/\/+$/, '')}/.ssh`
}

/** 账号的 authorized_keys 路径；同样只由服务端拼接。 */
export function authorizedKeysPath(homeDir: string): string {
  return `${sshDirPath(homeDir)}/authorized_keys`
}

/** 读出有效公钥行：去掉空行与 # 注释行，保留原文行（含行尾注释之外的任何内容）。 */
export function parseKeyLines(text: string): readonly string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/** 追加一行公钥：文件无结尾换行时补上，保证每行恰是一条公钥。 */
export function appendKeyLine(text: string, keyLine: string): string {
  const trimmed = text.replace(/\s+$/, '')
  return trimmed.length === 0 ? `${keyLine}\n` : `${trimmed}\n${keyLine}\n`
}

/** 按整行精确匹配移除一条公钥；行不存在时原样返回，由调用方决定是否报错。 */
export function removeKeyLine(text: string, keyLine: string): string {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.trim() === keyLine)
  if (index < 0) return text
  lines.splice(index, 1)
  return lines.join('\n')
}

/**
 * 替换文件里的第一条公钥行（Root 密钥卡只管理 root authorized_keys 的首行，其余行原样保留）；
 * 文件里还没有任何公钥行时，整份文件只剩新行。
 */
export function replaceFirstKeyLine(text: string, keyLine: string): string {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => {
    const trimmed = line.trim()
    return trimmed.length > 0 && !trimmed.startsWith('#')
  })
  if (index < 0) return `${keyLine}\n`
  lines[index] = keyLine
  return lines.join('\n')
}

/** FNV-1a 32 位：给公钥行派生稳定 id 的确定性哈希（非安全用途，只求跨读取稳定）。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 公钥行的稳定标识：同一行永远同一 id，删除按 id 反查整行。 */
export function keyLineId(keyLine: string): string {
  return `sshkey-${fnv1a(keyLine.trim())}`
}

/** 公钥行的注释段（第三段起）：面板用它当密钥名，本面板创建的行注释形如 elysian-<名称>。 */
export function keyCommentOf(keyLine: string): string {
  const fields = keyLine.trim().split(/\s+/)
  return fields.length >= 3 ? fields.slice(2).join(' ') : ''
}

/** ssh-keygen -lf 的输出：`256 SHA256:xxxx elysian-部署机 (ED25519)`。 */
export type KeygenFingerprint = {
  bits: number
  fingerprint: string
  comment: string
  /** 括号里的算法短名，如 ED25519。 */
  typeToken: string
}

/** 解析 -lf 输出行；形状不对返回 null。 */
export function parseKeygenFingerprint(stdout: string): KeygenFingerprint | null {
  const match = /^(\d+)\s+(SHA256:\S+)\s+(.*?)\s*\((\w+)\)\s*$/.exec(stdout.trim().split('\n')[0] ?? '')
  if (!match) return null
  const [, bitsText, fingerprint, comment, typeToken] = match
  const bits = Number.parseInt(bitsText ?? '', 10)
  if (!Number.isInteger(bits) || fingerprint === undefined || comment === undefined || typeToken === undefined) {
    return null
  }
  return { bits, fingerprint, comment, typeToken }
}

/** -lf 括号短名 → 公钥类型名（与 authorized_keys 首段同词）。 */
const TYPE_TOKEN_NAMES: Record<string, string> = {
  ED25519: 'ssh-ed25519',
  RSA: 'ssh-rsa',
  ECDSA: 'ecdsa-sha2-nistp256',
  DSA: 'ssh-dss',
}

/** 密钥算法的呈现文本，如 `ssh-ed25519 256`；未知短名原样保留。 */
export function algorithmLabelOf(fingerprint: KeygenFingerprint): string {
  const typeName = TYPE_TOKEN_NAMES[fingerprint.typeToken] ?? fingerprint.typeToken
  return `${typeName} ${fingerprint.bits}`
}
