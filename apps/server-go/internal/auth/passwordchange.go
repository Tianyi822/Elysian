package auth

import (
	"elysian/server/internal/shared"
)

// 改密核心（passwordChange.ts 等价物）：两次明文 → 校验 → scrypt 哈希 → 经注入的
// store 原子写盘。改密端点与 `elysian resetpwd` CLI 共用它；不触碰会话文件——既有
// 会话的失效由 epoch 机制自动完成（passwordChangedAt 变化 ⇒ 全部旧会话下一次请求即 401）。
//
// 错误分型：两个校验错误（两次不一致、不足 8 位）回 InvalidRequestError(400)——HTTP
// 端点经错误映射原文回 400，CLI 按普通错误打印 message，两类入口行为一致；哈希与写盘
// 的 IO 故障保持普通错误原样上抛（端点侧落 500），绝不混入 400。

// PasswordMinLength 新密码最小长度（UTF-16 计，与 TS length 同口径）。
const PasswordMinLength = 8

// ChangePanelPassword 改密纯流程：校验两次一致、长度达标后哈希落盘，返回完整新凭据。
func ChangePanelPassword(credentials CredentialsStore, hasher PasswordHasher, first, second string) (*PanelCredentials, error) {
	if first != second {
		return nil, shared.InvalidRequest("两次输入的密码不一致")
	}
	if utf16Length(first) < PasswordMinLength {
		return nil, shared.InvalidRequest("密码至少需要 8 位")
	}
	hash, err := hasher.Hash(first)
	if err != nil {
		return nil, err
	}
	return credentials.Write(hash)
}
