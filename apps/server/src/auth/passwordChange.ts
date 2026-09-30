import type { CredentialsStore, PanelCredentials } from './credentialsStore.ts'
import type { PasswordHasher } from './passwordHasher.ts'

/*
 * 改密核心纯函数：两次明文 → 校验 → scrypt 哈希 → 经注入的 store 原子写盘。
 * CLI（resetPasswordCli）与未来其他入口共用它；无 IO 依赖以外的副作用，vitest
 * 直接 import 单测。不触碰会话文件——既有会话的失效由 epoch 机制自动完成
 * （passwordChangedAt 变化 ⇒ 全部旧会话下一次请求即 401）。
 */

/** 新密码最小长度。 */
export const PASSWORD_MIN_LENGTH = 8

export type PasswordChangeDeps = {
  credentials: CredentialsStore
  hasher: PasswordHasher
}

export async function changePanelPassword(deps: PasswordChangeDeps, first: string, second: string): Promise<PanelCredentials> {
  if (first !== second) throw new Error('两次输入的密码不一致')
  if (first.length < PASSWORD_MIN_LENGTH) throw new Error('密码至少需要 8 位')
  return deps.credentials.write(await deps.hasher.hash(first))
}
