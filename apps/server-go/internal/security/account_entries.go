package security

import (
	"fmt"
)

// passwdEntries 全量 passwd 条目（getent 只跑一次，失败带命令上下文）。
func (s *sshService) passwdEntries() ([]PasswdEntry, error) {
	output, err := s.deps.runGetent([]string{"passwd"})
	if err != nil {
		return nil, s.commandError("getent", []string{"passwd"}, err)
	}
	return ParseGetentPasswdEntries(output), nil
}

// keyAccountEntries 密钥可归属的真实账号（有登录 shell、uid≥1000、非 root）。
func (s *sshService) keyAccountEntries() ([]PasswdEntry, error) {
	entries, err := s.passwdEntries()
	if err != nil {
		return nil, err
	}
	var accounts []PasswdEntry
	for _, entry := range entries {
		if IsKeyAccount(entry) {
			accounts = append(accounts, entry)
		}
	}
	return accounts, nil
}

// entryOf 单个账号的 passwd 条目：主目录只从 getent 推导，绝不接受客户端传路径。
func (s *sshService) entryOf(name string) (PasswdEntry, error) {
	output, err := s.deps.runGetent([]string{"passwd", name})
	if err != nil {
		return PasswdEntry{}, s.commandError("getent", []string{"passwd", name}, err)
	}
	entries := ParseGetentPasswdEntries(output)
	if len(entries) == 0 {
		return PasswdEntry{}, sharedInvalidRequest(fmt.Sprintf("未找到系统账号：%s", name))
	}
	return entries[0], nil
}

// ResetRootPassword 重置 Root 密码：控制字符拒绝（chpasswd 按行解析「账号:密码」，
// 含换行会越界改掉其他账号）；服务端复验强度；凭据经 chpasswd 的 stdin 下发，
// 绝不进命令行，错误信息只描述命令本身。
func (s *sshService) ResetRootPassword(password string) (SshPasswordResetResult, error) {
	if hasUnsafeControlChars(password) {
		return SshPasswordResetResult{}, sharedInvalidRequest("密码不能包含换行或控制字符")
	}
	strength := EvaluateSshPasswordStrength(password)
	if strength == "weak" {
		return SshPasswordResetResult{}, sharedInvalidRequest(
			"密码强度不足：判定为弱密码，请加长密码并混合大小写字母、数字与符号",
		)
	}
	if _, err := s.RootAuth(); err != nil {
		return SshPasswordResetResult{}, err
	}
	if _, err := s.deps.runChpasswd("root:" + password); err != nil {
		return SshPasswordResetResult{}, fmt.Errorf("chpasswd 执行失败：%w", err)
	}
	if err := s.writeStamp(s.paths.passwordResetAtStamp, s.deps.nowIso()); err != nil {
		return SshPasswordResetResult{}, fmt.Errorf("Root 密码已修改，但记录重置时间失败，请使用新密码登录：%w", err)
	}
	auth, err := s.RootAuth()
	if err != nil {
		return SshPasswordResetResult{}, fmt.Errorf("Root 密码已修改，但读取认证状态失败，请使用新密码登录：%w", err)
	}
	return SshPasswordResetResult{Auth: auth, Strength: strength}, nil
}

// KeyAccounts 密钥可归属的主机账号清单。
func (s *sshService) KeyAccounts() ([]SshKeyAccount, error) {
	output, err := s.deps.runGetent([]string{"passwd"})
	if err != nil {
		return nil, s.commandError("getent", []string{"passwd"}, err)
	}
	accounts := ListKeyAccounts(output)
	if accounts == nil {
		accounts = []SshKeyAccount{}
	}
	return accounts, nil
}
