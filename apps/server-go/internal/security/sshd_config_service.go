package security

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"elysian/server/internal/contract"
)

// serializeConfigWrite sshd_config 互斥队列：队列内失败不毒化后续操作。
func (s *sshService) serializeConfigWrite(critical func() error) error {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	return critical()
}

// readConfigText 读主配置原文。
func (s *sshService) readConfigText() (string, error) {
	text, err := s.deps.readText(s.paths.sshdConfig)
	if err != nil {
		return "", fmt.Errorf("无法读取 sshd 配置（%s）：%w", s.paths.sshdConfig, err)
	}
	return text, nil
}

// globToRegExp Include 通配符（`*` 与 `?`，仅单段内匹配）→ 正则。
func globToRegExp(pattern string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	for _, ch := range pattern {
		switch ch {
		case '*':
			b.WriteString("[^/]*")
		case '?':
			b.WriteString("[^/]")
		default:
			if strings.ContainsRune(`\^$.+|()[]{}`, ch) {
				b.WriteByte('\\')
			}
			b.WriteRune(ch)
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String())
}

// expandIncludePattern 展开单个 Include 路径：相对路径以主配置所在目录为基准，
// 含通配符时列目录按字典序（sshd_config(5)：Include 按词法序处理）逐个读取；
// 文件缺失或不可读按无内容处理。
func (s *sshService) expandIncludePattern(rawPattern string, depth int) (string, error) {
	if strings.ContainsAny(rawPattern, "\"'[]") {
		return "", sharedInvalidRequest("Include 含引号或不支持的通配符，无法完整核对条件配置，请人工整理后修改")
	}
	if slash := strings.LastIndexByte(rawPattern, '/'); slash >= 0 && strings.ContainsAny(rawPattern[:slash], "*?") {
		return "", sharedInvalidRequest("Include 目录含通配符，无法完整核对条件配置，请人工整理后修改")
	}
	configDir := s.paths.sshdConfig[:strings.LastIndexByte(s.paths.sshdConfig, '/')]
	absolute := rawPattern
	if !strings.HasPrefix(rawPattern, "/") {
		absolute = configDir + "/" + rawPattern
	}
	var candidates []string
	if strings.ContainsAny(absolute, "*?") {
		slash := strings.LastIndexByte(absolute, '/')
		dir, pattern := absolute[:slash], absolute[slash+1:]
		re := globToRegExp(pattern)
		names, _ := s.deps.readDir(dir)
		for _, name := range names {
			if re.MatchString(name) {
				candidates = append(candidates, dir+"/"+name)
			}
		}
		sort.Strings(candidates)
	} else {
		candidates = []string{absolute}
	}
	parts := []string{}
	for _, candidate := range candidates {
		if !s.deps.exists(candidate) {
			continue
		}
		content, err := s.deps.readText(candidate)
		if err != nil {
			continue
		}
		expanded, err := s.expandIncludes(content, depth+1)
		if err != nil {
			return "", err
		}
		parts = append(parts, expanded)
	}
	return strings.Join(parts, "\n"), nil
}

// expandIncludes 展开 Include 后的全量配置文本：Include 行按 sshd 语义原位替换为
// 所引文件内容，解析顺序（first-obtained）与真实 sshd 一致，面板由此读到生效值
// 而不是主文件值。Include 的 Keyword=Value 等号写法与空白写法等价，关键词识别前
// 先行归一；递归深度设上限（16），防止 drop-in 互相 Include 成环时读挂面板。
func (s *sshService) expandIncludes(text string, depth int) (string, error) {
	if depth >= 16 {
		return "", sharedInvalidRequest("Include 嵌套过深或存在循环，无法完整核对 SSH 配置")
	}
	out := []string{}
	for _, rawLine := range strings.Split(text, "\n") {
		line := normalizeConfigLine(rawLine)
		keyword := ""
		if line != "" {
			keyword = strings.ToLower(strings.Fields(line)[0])
		}
		if line != "" && keyword == "include" {
			for _, pattern := range strings.Fields(line)[1:] {
				expanded, err := s.expandIncludePattern(pattern, depth)
				if err != nil {
					return "", err
				}
				out = append(out, expanded)
			}
			continue
		}
		out = append(out, rawLine)
	}
	return strings.Join(out, "\n"), nil
}

// readEffectiveConfigText 读取展开 Include 后的 sshd 配置文本：settings 与 Root
// 策略都以生效值为准。
func (s *sshService) readEffectiveConfigText() (string, error) {
	original, err := s.readConfigText()
	if err != nil {
		return "", err
	}
	return s.expandIncludes(original, 0)
}

// settingsOf 解析配置文本为登录方式与端口；指令缺省时按 sshd 默认值呈现
// （sshd_config(5)：Port 22、两种认证默认开启）。
func (s *sshService) settingsOf(text string) SshAuthSettings {
	directives := parseSshdConfig(text)
	settings := SshAuthSettings{
		PasswordAuthEnabled: true,
		KeyAuthEnabled:      true,
		Port:                SSHDefaultPort,
	}
	if directives.port != nil {
		settings.Port = *directives.port
	}
	if directives.passwordAuthentication != nil {
		settings.PasswordAuthEnabled = *directives.passwordAuthentication
	}
	if directives.kbdInteractiveAuthentication != nil && *directives.kbdInteractiveAuthentication {
		settings.PasswordAuthEnabled = true
	}
	if directives.pubkeyAuthentication != nil {
		settings.KeyAuthEnabled = *directives.pubkeyAuthentication
	}
	return settings
}

// policyOf Root 登录策略：缺省 prohibit-password；无法识别的取值抛 500。
func policyOf(text string) (string, error) {
	raw := "prohibit-password"
	directives := parseSshdConfig(text)
	if directives.permitRootLogin != nil {
		raw = *directives.permitRootLogin
	}
	for _, candidate := range SSHRootLoginPolicies {
		if candidate == raw {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("sshd 配置里的 PermitRootLogin 取值无法识别：%s", raw)
}

// patchAndApply 串行验证候选配置、原子发布并应用；任何应用失败恢复原配置及服务状态。
func (s *sshService) patchAndApply(patch []sshdPatchEntry) error {
	return s.patchAndApplyPrepared(patch, nil)
}

func (s *sshService) patchAndApplyPrepared(patch []sshdPatchEntry, prepare func() error) error {
	return s.serializeConfigWrite(func() error {
		if s.deps.validateRuntime != nil {
			if err := s.deps.validateRuntime(); err != nil {
				return err
			}
		}
		original, err := s.readConfigText()
		if err != nil {
			return err
		}
		next := PatchSshdConfig(original, patch)
		portChanged := false
		expectedPort := 0
		for _, p := range patch {
			if p.Name == "Port" {
				portChanged = true
				expectedPort, _ = jsParseInt(p.Value)
			}
		}
		if s.deps.effectiveConfig != nil {
			expanded, e := s.expandIncludes(original, 0)
			if e != nil {
				return e
			}
			if err = validateSshPatchScope(expanded, patch); err != nil {
				return err
			}
		}
		if next == original {
			if portChanged && s.deps.effectiveConfig != nil {
				effective, e := s.deps.effectiveConfig("")
				if e != nil {
					return e
				}
				ports := sshListenPorts(effective)
				if len(ports) != 1 || !ports[expectedPort] {
					return sharedInvalidRequest("Include 中存在累积监听端口，请人工检查 sshd 配置")
				}
				running, e := s.serviceRunning()
				if e != nil {
					return e
				}
				if running && s.deps.verifyConfig != nil {
					if e = s.deps.verifyConfig(expectedPort); e != nil {
						return e
					}
				}
			}
			if prepare != nil {
				return prepare()
			}
			return nil
		}
		tmp := s.paths.sshdConfig + ".elysian-check"
		if err = s.refuseSymlink(s.paths.sshdConfig, "sshd 配置"); err != nil {
			return err
		}
		if err = s.refuseSymlink(tmp, "配置预检临时文件"); err != nil {
			return err
		}
		if err = s.deps.writeText(tmp, next); err != nil {
			return err
		}
		defer s.deps.remove(tmp)
		if _, err = s.deps.runSshd([]string{"-t", "-f", tmp}); err != nil {
			return sharedInvalidRequest(fmt.Sprintf("sshd 配置预检未通过，原配置未改动：%v", err))
		}
		if s.deps.effectiveConfig != nil {
			candidate, e := s.deps.runSshd([]string{"-T", "-f", tmp})
			if e != nil {
				return e
			}
			if portChanged && (len(sshListenPorts(candidate)) != 1 || !sshListenPorts(candidate)[expectedPort]) {
				return sharedInvalidRequest("Include 或监听地址配置仍声明其他端口，无法安全切换为单端口，请人工检查 sshd 配置")
			}
			for _, p := range patch {
				if p.Name == "Port" {
					continue
				}
				if !effectiveDirectiveMatches(candidate, p) {
					return sharedInvalidRequest("SSH 生效配置与请求不一致，请检查 " + p.Name + " 的外部覆盖")
				}
			}
		}
		running, err := s.serviceRunning()
		if err != nil {
			return err
		}
		var restoreState func() error
		if running && s.deps.captureServiceState != nil {
			restoreState, err = s.deps.captureServiceState()
			if err != nil {
				return err
			}
		}
		if prepare != nil {
			if err = prepare(); err != nil {
				return err
			}
		}
		if err = s.writeAtomic(s.paths.sshdConfig, &original, next); err != nil {
			return err
		}
		rollback := func(cause error) error {
			if rb := s.writeAtomic(s.paths.sshdConfig, nil, original); rb != nil {
				return fmt.Errorf("%v；恢复 SSH 原配置失败：%w", cause, rb)
			}
			if running {
				var rb error
				if restoreState != nil {
					rb = restoreState()
				} else if s.deps.applyConfig != nil {
					rb = s.deps.applyConfig(portChanged)
				} else {
					alive, _ := s.serviceRunning()
					if alive {
						rb = s.deps.reloadSshd()
					} else {
						rb = s.deps.startSshd()
					}
				}
				if rb == nil {
					ok, e := s.waitForServiceState(true)
					rb = e
					if !ok && rb == nil {
						rb = fmt.Errorf("SSH 原服务未恢复")
					}
				}
				if rb != nil {
					return fmt.Errorf("%v；原配置已恢复，但恢复 SSH 服务失败：%w", cause, rb)
				}
			}
			return fmt.Errorf("%w；已恢复 SSH 原配置和服务状态", cause)
		}
		if running {
			if s.deps.applyConfig != nil {
				err = s.deps.applyConfig(portChanged)
			} else {
				err = s.deps.reloadSshd()
			}
			if err != nil {
				return rollback(fmt.Errorf("应用 SSH 配置失败：%w", err))
			}
			alive, e := s.serviceAliveAfterReload()
			if e != nil {
				return rollback(e)
			}
			if !alive {
				return rollback(fmt.Errorf("重载后 sshd 进程退出"))
			}
			if portChanged && s.deps.verifyConfig != nil {
				if err = s.deps.verifyConfig(expectedPort); err != nil {
					return rollback(err)
				}
			}
		}
		return nil
	})
}

func effectiveDirectiveMatches(text string, p sshdPatchEntry) bool {
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) > 1 && strings.EqualFold(f[0], p.Name) {
			return strings.EqualFold(f[1], p.Value)
		}
	}
	return false
}

// 自定义 Match 或多因素策略不能用全局两档开关冒充已完成变更。
func validateSshPatchScope(text string, patch []sshdPatchEntry) error {
	inMatch := false
	for _, raw := range strings.Split(text, "\n") {
		f := strings.Fields(normalizeConfigLine(raw))
		if len(f) == 0 {
			continue
		}
		if strings.EqualFold(f[0], "Match") {
			inMatch = true
			continue
		}
		for _, p := range patch {
			if inMatch && strings.EqualFold(f[0], p.Name) {
				return sharedInvalidRequest("Match 条件覆盖了 " + p.Name + "，请先人工整理该条件配置")
			}
			if strings.EqualFold(f[0], "AuthenticationMethods") && len(f) > 1 && f[1] != "any" && (p.Name == "PasswordAuthentication" || p.Name == "PubkeyAuthentication" || p.Name == "KbdInteractiveAuthentication") {
				return sharedInvalidRequest("存在自定义 AuthenticationMethods 认证组合，请先人工核对登录方式")
			}
		}
	}
	return nil
}

// Settings 登录方式与监听端口（读展开 Include 后的生效值）。
func (s *sshService) effectiveConfigFor(user string) (string, error) {
	if s.deps.effectiveConfig != nil {
		return s.deps.effectiveConfig(user)
	}
	return s.readEffectiveConfigText()
}

func (s *sshService) Settings() (SshAuthSettings, error) {
	text, err := s.effectiveConfigFor("")
	if err != nil {
		return SshAuthSettings{}, err
	}
	return s.settingsOf(text), nil
}

// SetAuthMethods 保存登录方式开关：双指令补丁后回读生效值。
func (s *sshService) SetAuthMethods(passwordAuthEnabled, keyAuthEnabled bool) (SshAuthSettings, error) {
	passwordValue, keyValue := "no", "no"
	if passwordAuthEnabled {
		passwordValue = "yes"
	}
	if keyAuthEnabled {
		keyValue = "yes"
	}
	patch := []sshdPatchEntry{{Name: "PasswordAuthentication", Value: passwordValue}, {Name: "PubkeyAuthentication", Value: keyValue}}
	if !passwordAuthEnabled {
		patch = append(patch, sshdPatchEntry{Name: "KbdInteractiveAuthentication", Value: "no"})
	}
	if err := s.patchAndApply(patch); err != nil {
		return SshAuthSettings{}, err
	}
	return s.Settings()
}

// SetPort 保存监听端口：判据与表单共用同一函数（界面挡一次，这里再挡一次，
// 绕过界面也写不进配置）；非法端口零写入。
func (s *sshService) SetPort(port float64) (SshAuthSettings, error) {
	if !IsValidSshPort(port) {
		return SshAuthSettings{}, sharedInvalidRequest("SSH 端口需为 1-65535 的整数")
	}
	var syncResult *contract.FirewallPortSync
	if err := s.patchAndApplyPrepared([]sshdPatchEntry{{Name: "Port", Value: jsNumberToString(port)}}, func() error {
		if s.deps.ports == nil {
			return nil
		}
		result := s.deps.ports.EnsurePortRule(context.Background(), int(port), "SSH 端口联动放行")
		syncResult = &result
		if result.State == contract.FirewallPortSyncFailed {
			detail := "无法放行新端口"
			if result.Detail != nil {
				detail = *result.Detail
			}
			return sharedInvalidRequest("SSH 端口未修改：" + detail)
		}
		return nil
	}); err != nil {
		return SshAuthSettings{}, err
	}
	settings, err := s.Settings()
	settings.FirewallPort = syncResult
	return settings, err
}

// SaveRootLoginPolicy 保存 Root 登录策略：取值限契约枚举（服务端复验）。
func (s *sshService) SaveRootLoginPolicy(policy string) (SshRootAuth, error) {
	valid := false
	for _, candidate := range SSHRootLoginPolicies {
		if candidate == policy {
			valid = true
			break
		}
	}
	if !valid {
		return SshRootAuth{}, sharedInvalidRequest(fmt.Sprintf("无效的 Root 登录策略：%s", policy))
	}
	if err := s.patchAndApply([]sshdPatchEntry{{Name: "PermitRootLogin", Value: policy}}); err != nil {
		return SshRootAuth{}, err
	}
	return s.RootAuth()
}
