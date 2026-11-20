package security

import (
	"fmt"
	"strings"
)

// authorizedKeysText 账号的 authorized_keys 内容；无文件为 nil。
func (s *sshService) authorizedKeysText(entry PasswdEntry) *string {
	path := authorizedKeysPath(entry.Home)
	if !s.deps.exists(path) {
		return nil
	}
	text, err := s.deps.readText(path)
	if err != nil {
		return nil
	}
	return &text
}

// verifyPublicKey 公钥行经 ssh-keygen -lf 验证并取指纹：非法行在这里被拒，永远
// 到不了 authorized_keys。
func (s *sshService) verifyPublicKey(keyLine string) (KeygenFingerprint, error) {
	if err := s.ensureDir(s.paths.keygenWorkspace); err != nil {
		return KeygenFingerprint{}, err
	}
	seq := s.tempSeq.Add(1)
	verifyPath := fmt.Sprintf("%s/verify-%d.pub", s.paths.keygenWorkspace, seq)
	if err := s.deps.writeText(verifyPath, keyLine+"\n"); err != nil {
		return KeygenFingerprint{}, err
	}
	defer func() {
		_ = s.deps.remove(verifyPath)
	}()
	stdout, err := s.deps.runSshKeygen([]string{"-lf", verifyPath})
	if err != nil {
		return KeygenFingerprint{}, s.commandError("ssh-keygen", []string{"-lf", verifyPath}, err)
	}
	parsed := ParseKeygenFingerprint(stdout)
	if parsed == nil {
		return KeygenFingerprint{}, fmt.Errorf("ssh-keygen 指纹输出无法解析：%s", strings.TrimSpace(stdout))
	}
	return *parsed, nil
}

// writeAuthorizedKeys authorized_keys 的原子写、权限收紧与属主落位：目录 0700、
// 文件 0600，均 chown 到账号名下，写前备份。符号链接防线先于一切权限与写盘动作。
func (s *sshService) checkAuthorizedKeys(entry PasswdEntry) error {
	if s.deps.effectiveConfig == nil {
		return nil
	}
	expanded, e := s.readEffectiveConfigText()
	if e != nil {
		return e
	}
	if e = validateSshPatchScope(expanded, []sshdPatchEntry{{Name: "AuthorizedKeysFile", Value: ".ssh/authorized_keys"}}); e != nil {
		return e
	}
	text, err := s.effectiveConfigFor(entry.Name)
	if err != nil {
		return err
	}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) > 1 && f[0] == "authorizedkeysfile" {
			for _, path := range f[1:] {
				if path == ".ssh/authorized_keys" || path == "%h/.ssh/authorized_keys" || path == authorizedKeysPath(entry.Home) {
					return nil
				}
			}
			return sharedInvalidRequest("账号 " + entry.Name + " 使用自定义 AuthorizedKeysFile，面板未写入，请人工管理该授权文件")
		}
	}
	return sharedInvalidRequest("无法确定账号 " + entry.Name + " 的 SSH 授权文件")
}

func (s *sshService) writeAuthorizedKeys(entry PasswdEntry, original *string, next string) error {
	if err := s.checkAuthorizedKeys(entry); err != nil {
		return err
	}
	dir := sshDirPath(entry.Home)
	target := authorizedKeysPath(entry.Home)
	if err := s.refuseSymlink(dir, "账号的 .ssh 目录"); err != nil {
		return err
	}
	if err := s.refuseSymlink(target, "authorized_keys 文件"); err != nil {
		return err
	}
	if err := s.ensureDir(dir); err != nil {
		return err
	}
	if err := s.deps.chmod(dir, 0o700); err != nil {
		return err
	}
	if err := s.deps.chown(dir, entry.UID, entry.GID); err != nil {
		return err
	}
	return s.writeAtomicOwned(target, original, next, &entry)
}
