import { invalidRequest } from '../shared/errors.ts'
import type { CredentialsStore, PanelCredentials } from './credentialsStore.ts'
import type { PasswordHasher } from './passwordHasher.ts'

/*
 * 改密核心纯函数：两次明文 → 校验 → scrypt 哈希 → 经注入的 store 原子写盘。
 * CLI（resetPasswordCli）与未来其他入口共用它；无 IO 依赖以外的副作用，vitest
 * 直接 import 单测。不触碰会话文件——既有会话的失效由 epoch 机制自动完成
 * （passwordChangedAt 变化 ⇒ 全部旧会话下一次请求即 401）。
 *
 * 错误分型：两个校验错误（两次不一致、不足 8 位）抛 InvalidRequestError(400)——
 * HTTP 端点经 endpointErrorHandler 原文映射 400，CLI 按普通 Error 打印 message，
 * 两类入口行为一致；哈希与写盘的 IO 故障保持普通 Error 原样上抛，绝不混入 400。
 */

/** 新密码最小长度。 */
export const PASSWORD_MIN_LENGTH = 8

export type PasswordChangeDeps = {
  credentials: CredentialsStore
  hasher: PasswordHasher
}

export async function changePanelPassword(deps: PasswordChangeDeps, first: string, second: string): Promise<PanelCredentials> {
  if (first !== second) throw invalidRequest('两次输入的密码不一致')
  if (first.length < PASSWORD_MIN_LENGTH) throw invalidRequest('密码至少需要 8 位')
  return deps.credentials.write(await deps.hasher.hash(first))
}
