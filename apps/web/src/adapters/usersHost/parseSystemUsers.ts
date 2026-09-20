import type { HostUser, HostUserLoginMethod, HostUserStatus } from '@elysian/contracts'
import { parseKeyLines } from '../sshHost/authorizedKeys'

/*
 * 系统账号状态的纯推导：passwd / shadow / group（getent 输出）到 HostUser 视图模型的映射。
 * 只做解析与推导，不执行任何命令；服务编排（usersService）据此决定写命令，
 * 写后回读也走同一套推导——界面永远看到真实状态，而不是命令的乐观假设。
 */

/** 面板管理的 uid 下界：普通用户从 1000 起，root 与系统账号不在此列。 */
export const MANAGED_UID_MIN = 1000
/** 面板管理的 uid 上界：nobody(65534) 这类保留账号排除在外。 */
export const MANAGED_UID_MAX = 60000

/** getent passwd 的一行：name:passwd:uid:gid:gecos:home:shell。 */
export type PasswdRecord = {
  name: string
  uid: number
  gid: number
  gecos: string
  home: string
  shell: string
}

/** 解析单行 passwd；字段不足或 uid/gid 非数字时返回 null。 */
export function parsePasswdLine(line: string): PasswdRecord | null {
  const fields = line.trim().split(':')
  if (fields.length < 7) return null
  const [name, , uidText, gidText, gecos, home, shell] = fields
  const uid = Number.parseInt(uidText ?? '', 10)
  const gid = Number.parseInt(gidText ?? '', 10)
  if (!name || !home || !shell || !Number.isInteger(uid) || !Number.isInteger(gid)) return null
  return { name, uid, gid, gecos: gecos ?? '', home, shell }
}

/** 解析 getent passwd 的多行输出，跳过无法辨认的行。 */
export function parseGetentPasswd(output: string): readonly PasswdRecord[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parsePasswdLine)
    .filter((entry): entry is PasswdRecord => entry !== null)
}

/** getent shadow 的一行：name:hash:lastchg:min:max:warn:inact:expire:flag。 */
export type ShadowRecord = {
  name: string
  /** 密码字段原文：可用哈希、锁定前缀（!）、占位（*）或空。 */
  passwordHash: string
  /** 账号过期日（自 1970-01-01 起的天数）；未设置或负值（不过期）为 null。 */
  expireDays: number | null
}

/** 解析单行 shadow；字段不足或形状不对时返回 null。 */
export function parseShadowLine(line: string): ShadowRecord | null {
  const fields = line.trim().split(':')
  if (fields.length < 8) return null
  const [name, passwordHash, , , , , , expireText] = fields
  if (!name) return null
  let expireDays: number | null = null
  if (expireText !== undefined && expireText !== '') {
    const parsed = Number.parseInt(expireText, 10)
    // 负值按 shadow(5) 语义表示不过期，与空字段同样视为「未设置」。
    if (Number.isInteger(parsed) && parsed >= 0) expireDays = parsed
  }
  return { name, passwordHash: passwordHash ?? '', expireDays }
}

/** 解析 getent shadow 的多行输出，跳过无法辨认的行。 */
export function parseGetentShadow(output: string): readonly ShadowRecord[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseShadowLine)
    .filter((entry): entry is ShadowRecord => entry !== null)
}

/** 解析 getent group sudo 的成员集：`sudo:x:27:ubuntu,elysian` 的第四字段按逗号切分。 */
export function parseGroupMembers(output: string): ReadonlySet<string> {
  const members = new Set<string>()
  for (const line of output.split('\n')) {
    const fields = line.trim().split(':')
    if (fields.length < 4) continue
    for (const member of (fields[3] ?? '').split(',')) {
      const name = member.trim()
      if (name) members.add(name)
    }
  }
  return members
}

/** 是否落在面板可管理的 uid 范围（1000-60000）：root、系统账号与 nobody 保留账号都不在。 */
export function isManagedUid(uid: number): boolean {
  return uid >= MANAGED_UID_MIN && uid <= MANAGED_UID_MAX
}

/** 无登录能力的 shell：nologin 与 false 都无法承载交互登录（/sbin/nologin 与 /usr/sbin/nologin 同判）。 */
export function isNoLoginShell(shell: string): boolean {
  const base = shell.split('/').pop() ?? shell
  return base === 'nologin' || base === 'false'
}

/**
 * shadow 密码字段是否为可用哈希：空串、裸 `!`、`*` 都不可用，`!` 前缀是锁定标记同样不可用
 * （usermod -L 就是在哈希前加 `!`）。
 */
export function passwordUsable(passwordHash: string): boolean {
  return passwordHash !== '' && passwordHash !== '!' && passwordHash !== '*' && !passwordHash.startsWith('!')
}

/** authorized_keys 是否提供可用的密钥路径：有至少一条有效公钥行（空行与 # 注释行不算）。 */
export function keyUsable(authorizedKeysText: string | null): boolean {
  return authorizedKeysText !== null && parseKeyLines(authorizedKeysText).length > 0
}

/**
 * 登录方式的诚实推导：shell 为 nologin 时一律 none；否则按「密码可用」与「密钥可用」
 * 组合出四档。两者皆无时如实呈现 none——实际没有任何可用方式，不呈现界面请求的样子。
 */
export function loginMethodOf(state: {
  shell: string
  passwordHash: string | null
  authorizedKeysText: string | null
}): HostUserLoginMethod {
  if (isNoLoginShell(state.shell)) return 'none'
  const byPassword = state.passwordHash !== null && passwordUsable(state.passwordHash)
  const byKey = keyUsable(state.authorizedKeysText)
  if (byPassword && byKey) return 'password-or-key'
  if (byPassword) return 'password'
  if (byKey) return 'key'
  return 'none'
}

/** 自 1970-01-01（UTC）起的天数：shadow 的日期字段与今天都换算到同一标尺再比较。 */
export function daysSinceEpochUtc(iso: string): number {
  return Math.floor(Date.parse(iso) / 86_400_000)
}

/**
 * 账号状态推导：sp_expire 已设置且不晚于今天即 disabled——账号过期挡一切登录，
 * 无论登录方式为何。其余（含未设置过期）为 active。
 */
export function statusOf(expireDays: number | null, nowIso: string): HostUserStatus {
  if (expireDays === null) return 'active'
  return expireDays <= daysSinceEpochUtc(nowIso) ? 'disabled' : 'active'
}

/**
 * 备注取 passwd 第 5 字段（GECOS 全文）trim 后的值，空为 null。
 * 写侧用 useradd/usermod -c <备注> 落的就是这一字段，读写同一口径才能回读一致；
 * 逗号在写侧被拒绝（GECOS 里逗号用于分字段），因此读到的就是整条备注。
 */
export function noteOfGecos(gecos: string): string | null {
  const note = gecos.trim()
  return note === '' ? null : note
}

/**
 * 把单个账号的各源数据推导成 HostUser 视图。/etc/passwd 不记录账号创建时间、
 * 容器 overlayfs 的 btime 不可靠，createdAt 恒为 null（契约如此约定，界面显示 —）。
 */
export function deriveHostUser(state: {
  passwd: PasswdRecord
  shadow: ShadowRecord | null
  sudoMembers: ReadonlySet<string>
  authorizedKeysText: string | null
  nowIso: string
}): HostUser {
  return {
    id: state.passwd.name,
    name: state.passwd.name,
    isAdmin: state.sudoMembers.has(state.passwd.name),
    loginMethod: loginMethodOf({
      shell: state.passwd.shell,
      passwordHash: state.shadow?.passwordHash ?? null,
      authorizedKeysText: state.authorizedKeysText,
    }),
    status: statusOf(state.shadow?.expireDays ?? null, state.nowIso),
    note: noteOfGecos(state.passwd.gecos),
    createdAt: null,
  }
}
