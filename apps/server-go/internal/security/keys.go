package security

import (
	"fmt"
	"strings"
)

// keyCommentPrefix 面板创建的密钥注释前缀：authorized_keys 里据此识别归属面板
// 管理的名称。
const keyCommentPrefix = "elysian-"

// serializeKeysWrite authorized_keys 互斥队列：队列内失败不毒化后续操作。
func (s *sshService) serializeKeysWrite(critical func() error) error {
	s.keysMu.Lock()
	defer s.keysMu.Unlock()
	return critical()
}

// firstSeenAt 行 id → 会话首次观察到的时间（authorized_keys 无时间戳）。
func (s *sshService) firstSeenAt(lineId string) string {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	at, ok := s.keyFirstSeenAt[lineId]
	if !ok {
		at = s.deps.nowIso()
		s.keyFirstSeenAt[lineId] = at
	}
	return at
}

// keyNameOf authorized_keys 注释 → 面板密钥名：面板创建的行注释形如
// elysian-<名称>，外来行按注释原样呈现，无注释为「未命名」。
func keyNameOf(keyLine string) string {
	comment := KeyCommentOf(keyLine)
	if strings.HasPrefix(comment, keyCommentPrefix) {
		return comment[len(keyCommentPrefix):]
	}
	if comment != "" {
		return comment
	}
	return "未命名"
}

// keysOfAccount 单账号的密钥清单附带报告：无法验证的 authorized_keys 行只跳过并
// 计数，不抛错。
func (s *sshService) keysOfAccount(entry PasswdEntry) (sshListKeysReport, error) {
	text := s.authorizedKeysText(entry)
	if text == nil {
		return sshListKeysReport{Keys: []SshLoginKey{}, IgnoredInvalidLines: 0}, nil
	}
	keys := []SshLoginKey{}
	ignoredInvalidLines := 0
	for _, line := range ParseKeyLines(*text) {
		// 一条脏行（如手工粘坏的外来公钥）不该拖垮整个列表，也不该连累密钥创建入口。
		fingerprint, err := s.verifyPublicKey(line)
		if err != nil {
			ignoredInvalidLines++
			continue
		}
		// id 含账号维度：同一公钥行装进多个账号时 id 各不相同，删除不会误删别的账号的同款行。
		id := AuthorizedKeyId(entry.Name, line)
		keys = append(keys, SshLoginKey{
			ID:          id,
			Name:        keyNameOf(line),
			UserID:      entry.Name,
			Algorithm:   AlgorithmLabelOf(fingerprint),
			Fingerprint: fingerprint.Fingerprint,
			CreatedAt:   s.firstSeenAt(id),
			PublicKey:   line,
		})
	}
	return sshListKeysReport{Keys: keys, IgnoredInvalidLines: ignoredInvalidLines}, nil
}

// RootAuth Root 登录策略与 Root 凭据：策略读生效值；密钥材料取 root
// authorized_keys 首个可验证行（无则 null）；密码重置时间读宿主时间戳文件。
func (s *sshService) RootAuth() (SshRootAuth, error) {
	text, err := s.effectiveConfigFor("root")
	if err != nil {
		return SshRootAuth{}, err
	}
	policy, err := policyOf(text)
	if err != nil {
		return SshRootAuth{}, err
	}
	root, err := s.entryOf("root")
	if err != nil {
		return SshRootAuth{}, err
	}
	keysText := s.authorizedKeysText(root)
	passwordResetAt := s.readStamp(s.paths.passwordResetAtStamp)
	if keysText != nil {
		for _, line := range ParseKeyLines(*keysText) {
			fingerprint, err := s.verifyPublicKey(line)
			if err != nil {
				continue
			}
			return SshRootAuth{
				Policy: policy,
				Key: &SshRootKey{
					Algorithm:   AlgorithmLabelOf(fingerprint),
					Fingerprint: fingerprint.Fingerprint,
					CreatedAt:   s.firstSeenAt(KeyLineId(line)),
					PublicKey:   line,
				},
				PasswordResetAt: passwordResetAt,
			}, nil
		}
	}
	return SshRootAuth{Policy: policy, Key: nil, PasswordResetAt: passwordResetAt}, nil
}

// generateKeyPair 生成 ed25519 密钥对：私钥读进内存后立即删除临时文件，此后私钥
// 只在本次响应里，任何落盘内容不得含私钥（删除失败静默）。
func (s *sshService) generateKeyPair(comment string, prefix string, recordError bool) (string, string, error) {
	if err := s.ensureDir(s.paths.keygenWorkspace); err != nil {
		return "", "", err
	}
	seq := s.tempSeq.Add(1)
	keyPath := fmt.Sprintf("%s/%s-%d", s.paths.keygenWorkspace, prefix, seq)
	defer func() { _ = s.deps.remove(keyPath); _ = s.deps.remove(keyPath + ".pub") }()
	args := []string{"-t", "ed25519", "-C", comment, "-N", "", "-f", keyPath}
	if _, err := s.deps.runSshKeygen(args); err != nil {
		if recordError {
			return "", "", s.commandError("ssh-keygen", args, err)
		}
		return "", "", err
	}
	privateKey, privateKeyErr := s.deps.readText(keyPath)
	publicRaw, publicErr := s.deps.readText(keyPath + ".pub")
	if privateKeyErr != nil {
		return "", "", privateKeyErr
	}
	if publicErr != nil {
		return "", "", publicErr
	}
	return privateKey, strings.TrimSpace(publicRaw), nil
}

// CreateRootKey 生成（或重新生成）Root 密钥：新公钥替换 root authorized_keys 的
// 首个非空非注释行（外来行保留），旧私钥随之作废；私钥仅随本次响应一次性返回。
func (s *sshService) CreateRootKey() (SshRootAuth, error) {
	root, err := s.entryOf("root")
	if err != nil {
		return SshRootAuth{}, err
	}
	text, err := s.effectiveConfigFor("root")
	if err != nil {
		return SshRootAuth{}, err
	}
	policy, err := policyOf(text)
	if err != nil {
		return SshRootAuth{}, err
	}
	privateKey, publicKey, err := s.generateKeyPair(keyCommentPrefix+"root", "elysian-root-key", true)
	if err != nil {
		return SshRootAuth{}, err
	}

	fingerprint, err := s.verifyPublicKey(publicKey)
	if err != nil {
		return SshRootAuth{}, err
	}
	if err := s.serializeKeysWrite(func() error {
		original := s.authorizedKeysText(root)
		next := ReplaceFirstKeyLine("", publicKey)
		if original != nil {
			next = ReplaceFirstKeyLine(*original, publicKey)
		}
		return s.writeAuthorizedKeys(root, original, next)
	}); err != nil {
		return SshRootAuth{}, err
	}
	createdAt := s.deps.nowIso()
	s.stateMu.Lock()
	s.keyFirstSeenAt[KeyLineId(publicKey)] = createdAt
	s.stateMu.Unlock()

	return SshRootAuth{
		Policy: policy,
		Key: &SshRootKey{
			Algorithm:   AlgorithmLabelOf(fingerprint),
			Fingerprint: fingerprint.Fingerprint,
			CreatedAt:   createdAt,
			PublicKey:   publicKey,
			PrivateKey:  &privateKey,
		},
		PasswordResetAt: s.readStamp(s.paths.passwordResetAtStamp),
	}, nil
}

// ListKeysWithReport 登录密钥列表（附带脏行计数，列表永不因单行失败整体失败）。
func (s *sshService) ListKeysWithReport() (sshListKeysReport, error) {
	accounts, err := s.keyAccountEntries()
	if err != nil {
		return sshListKeysReport{}, err
	}
	keys := []SshLoginKey{}
	ignoredInvalidLines := 0
	for _, entry := range accounts {
		report, err := s.keysOfAccount(entry)
		if err != nil {
			return sshListKeysReport{}, err
		}
		keys = append(keys, report.Keys...)
		ignoredInvalidLines += report.IgnoredInvalidLines
	}
	return sshListKeysReport{Keys: keys, IgnoredInvalidLines: ignoredInvalidLines}, nil
}

// CreateKey 创建登录密钥：名称去空白后校验并拒绝换行/控制字符；查重、生成与落盘
// 整体进互斥队列（每次追加都基于最新 authorized_keys 计算）；归属账号必须是白名单
// 里的真实系统账号，路径全部由服务端推导；私钥仅随创建响应一次性返回。
func (s *sshService) CreateKey(name string, userId string) (SshLoginKey, error) {
	trimmed := strings.TrimSpace(name)
	if !IsValidSshKeyName(trimmed) {
		return SshLoginKey{}, sharedInvalidRequest(fmt.Sprintf("密钥名称需为 1-%d 个字符", SSHKeyNameMaxLength))
	}
	if hasUnsafeControlChars(name) {
		return SshLoginKey{}, sharedInvalidRequest("密钥名称不能包含换行或控制字符")
	}

	var created SshLoginKey
	err := s.serializeKeysWrite(func() error {
		accounts, err := s.keyAccountEntries()
		if err != nil {
			return err
		}
		var account *PasswdEntry
		for i := range accounts {
			if accounts[i].Name == userId {
				account = &accounts[i]
				break
			}
		}
		if account == nil {
			return sharedInvalidRequest(fmt.Sprintf("归属账号不存在：%s", userId))
		}

		report, err := s.ListKeysWithReport()
		if err != nil {
			return err
		}
		for _, existing := range report.Keys {
			if existing.Name == trimmed {
				return sharedInvalidRequest(fmt.Sprintf("密钥名称已存在：%s", trimmed))
			}
		}

		privateKey, publicKey, err := s.generateKeyPair(keyCommentPrefix+trimmed, "elysian-key", true)
		if err != nil {
			return err
		}
		fingerprint, err := s.verifyPublicKey(publicKey)
		if err != nil {
			return err
		}
		original := s.authorizedKeysText(*account)
		next := AppendKeyLine("", publicKey)
		if original != nil {
			next = AppendKeyLine(*original, publicKey)
		}
		if err := s.writeAuthorizedKeys(*account, original, next); err != nil {
			return err
		}

		id := AuthorizedKeyId(account.Name, publicKey)
		createdAt := s.deps.nowIso()
		s.stateMu.Lock()
		s.keyFirstSeenAt[id] = createdAt
		s.stateMu.Unlock()
		created = SshLoginKey{
			ID:          id,
			Name:        trimmed,
			UserID:      account.Name,
			Algorithm:   AlgorithmLabelOf(fingerprint),
			Fingerprint: fingerprint.Fingerprint,
			CreatedAt:   createdAt,
			PublicKey:   publicKey,
			PrivateKey:  &privateKey,
		}
		return nil
	})
	if err != nil {
		return SshLoginKey{}, err
	}
	return created, nil
}

// RemoveKey 删除登录密钥：遍历白名单账号找 id 命中行（id 含账号维度，只撤销目标
// 账号里的那一行）；找不到抛 400。
func (s *sshService) RemoveKey(keyId string) error {
	return s.serializeKeysWrite(func() error {
		accounts, err := s.keyAccountEntries()
		if err != nil {
			return err
		}
		for _, entry := range accounts {
			text := s.authorizedKeysText(entry)
			if text == nil {
				continue
			}
			for _, line := range ParseKeyLines(*text) {
				if AuthorizedKeyId(entry.Name, line) == keyId {
					return s.writeAuthorizedKeys(entry, text, RemoveKeyLine(*text, line))
				}
			}
		}
		return sharedInvalidRequest(fmt.Sprintf("未找到登录密钥 %s", keyId))
	})
}
