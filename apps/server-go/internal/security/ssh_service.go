package security

// SSH 面板的服务编排（sshService.ts 的 Go 等价物）：把界面动作翻译成容器内
// sshd / ssh-keygen / chpasswd 的真实执行。全部系统访问经 deps 注入，编排逻辑
// 在 go test 里用有状态 fake（内存文件与命令账本）驱动，不执行任何真实命令。
//
// 安全红线（逐条对齐 TS 版）：
//   - 命令全部数组传参，绝不拼 shell 字符串；密钥名称与 Root 密码拒绝换行与控制字符
//     （密码按行进 chpasswd 的 stdin，含换行会越界改掉其他账号）。
//   - sshd_config 只补丁四个白名单指令，写前备份、临时文件加 rename 原子落盘，
//     `sshd -t` 预检失败立即回滚原配置——回滚同样走原子写；补丁全程进串行队列；
//     SIGHUP 重载后短轮询复查服务存活，进程退出立即用原文原子回滚并如实报错。
//   - 服务在跑与否以 pidfile 加 /proc/<pid>/comm 双核实；停止信号只发给核实过
//     身份的进程。
//   - authorized_keys 行级编辑：公钥行经 ssh-keygen -lf 验证后追加/删除，
//     .ssh 0700、文件 0600、属主落到账号名下；行 id 含账号维度；全部读-改-写进
//     互斥队列。列表对无法验证的脏行只跳过并计数。
//   - 符号链接防线：.ssh、authorized_keys 与原子写的 .bak/.elysian-tmp 在任何
//     权限与写盘动作之前 lstat 拒绝符号链接。
//   - Root 密码只走 chpasswd 的 stdin，不进命令行参数。
//   - 私钥只在创建/生成响应里一次性带出：生成后立即读出并删除临时密钥文件。

import (
	"context"
	"elysian/server/internal/contract"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"elysian/server/internal/shared"
)

// keyCommentPrefix 面板创建的密钥注释前缀：authorized_keys 里据此识别归属面板
// 管理的名称。
const keyCommentPrefix = "elysian-"

// sshAPI 路由层消费的服务面（含密钥列表的脏行报告）。
type sshAPI interface {
	Overview() (SshOverview, error)
	Settings() (SshAuthSettings, error)
	RootAuth() (SshRootAuth, error)
	SetServiceEnabled(enabled bool) (SshOverview, error)
	SetAuthMethods(passwordAuthEnabled, keyAuthEnabled bool) (SshAuthSettings, error)
	SetPort(port float64) (SshAuthSettings, error)
	SaveRootLoginPolicy(policy string) (SshRootAuth, error)
	ResetRootPassword(password string) (SshPasswordResetResult, error)
	CreateRootKey() (SshRootAuth, error)
	ListKeysWithReport() (sshListKeysReport, error)
	ListLoginRecords() ([]SshLoginRecord, error)
	KeyAccounts() ([]SshKeyAccount, error)
	CreateKey(name string, userId string) (SshLoginKey, error)
	RemoveKey(keyId string) error
}

// sshService 服务实现：会话内存状态（行首次观察时间、临时序号）与两条互斥队列。
type sshService struct {
	deps    *sshHostDeps
	paths   sshPaths
	stateMu sync.Mutex
	// keyFirstSeenAt 公钥行 id → 本次会话首次观察到的时间：authorized_keys 无
	// 时间戳，创建时间是会话记忆。
	keyFirstSeenAt map[string]string
	// loginLineFirstSeenAt 无时间戳的日志行（sshd -E 裸行）→ 本次会话首次观察到
	// 的时间；进程重启后清零是固有限制（不修复为持久化）。
	loginLineFirstSeenAt map[string]string
	// tempSeq 密钥生成与指纹验证的临时文件序号：队列外原子自增，避免并发互踩。
	tempSeq atomic.Int64
	// keysMu authorized_keys 读-改-写的互斥队列：并发的创建/删除/重生成排队执行，
	// 每次变更都基于最新落盘内容计算；队列内失败不阻塞后续。
	keysMu sync.Mutex
	// configMu sshd_config 读-改-写的互斥队列（与 keysMu 独立）。
	configMu sync.Mutex
}

// newSshService 构造服务；deps.pathsOverride 为 nil 时用缺省路径表。
func newSshService(deps *sshHostDeps) *sshService {
	return &sshService{
		deps:                 deps,
		paths:                sshDepsPaths(deps.pathsOverride),
		keyFirstSeenAt:       map[string]string{},
		loginLineFirstSeenAt: map[string]string{},
	}
}

// serializeKeysWrite authorized_keys 互斥队列：队列内失败不毒化后续操作。
func (s *sshService) serializeKeysWrite(critical func() error) error {
	s.keysMu.Lock()
	defer s.keysMu.Unlock()
	return critical()
}

// serializeConfigWrite sshd_config 互斥队列：队列内失败不毒化后续操作。
func (s *sshService) serializeConfigWrite(critical func() error) error {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	return critical()
}

// commandError 命令失败的统一包装：detail 优先取 stderr（真实接线已归一为错误
// 消息），`${command} 执行失败（${完整命令行}）：${detail}`。
func (s *sshService) commandError(command string, args []string, err error) error {
	full := append([]string{command}, args...)
	return fmt.Errorf("%s 执行失败（%s）：%v", command, strings.Join(full, " "), err)
}

// ensureDir 路径不存在时递归创建。
func (s *sshService) ensureDir(path string) error {
	if !s.deps.exists(path) {
		return s.deps.mkdir(path)
	}
	return nil
}

// refuseSymlink 写入前的符号链接防线：面板以 root 写账号主目录与系统配置，路径
// 最终组件被预置符号链接（如 ~/.ssh → /etc）会让后续 chmod/chown 与备份写以 root
// 跟随作用到链接目标。lstat 不跟随符号链接：路径不存在视为无链可跟；探测失败同样
// 放行，由接线层 O_NOFOLLOW 的写入兜底；是符号链接即拒绝本次写入。
func (s *sshService) refuseSymlink(path string, label string) error {
	isLink, err := s.deps.lstat(path)
	if err != nil {
		return nil
	}
	if isLink {
		return sharedInvalidRequest(fmt.Sprintf(
			"安全检查未通过：%s（%s）是符号链接，已拒绝写入。面板不跟随符号链接写系统文件，请人工检查该路径是否被篡改",
			label, path,
		))
	}
	return nil
}

// readStamp 读时间戳文件：不存在/读失败/trim 后空 → nil。
func (s *sshService) readStamp(path string) *string {
	if !s.deps.exists(path) {
		return nil
	}
	text, err := s.deps.readText(path)
	if err != nil {
		return nil
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// writeStamp 写时间戳文件：先建父目录再落 ISO 时间戳。
func (s *sshService) writeStamp(path string, iso string) error {
	if slash := strings.LastIndexByte(path, '/'); slash > 0 {
		if err := s.ensureDir(path[:slash]); err != nil {
			return err
		}
	}
	return s.deps.writeText(path, iso)
}

// serviceRunning pidfile 存在只是线索：pid 可能已被无关进程复用。读
// /proc/<pid>/comm 核实身份后才算在跑；pidfile 读不出、pid 非法或 comm 读不到
// （进程已退）都按未运行处理。
func (s *sshService) serviceRunning() (bool, error) {
	if s.deps.serviceState != nil {
		return s.deps.serviceState()
	}
	pidText, err := s.deps.readText(s.paths.sshdPidFile)
	if err != nil {
		return false, nil
	}
	pid, valid := jsParseInt(strings.TrimSpace(pidText))
	if !valid {
		return false, nil
	}
	comm, err := s.deps.readText(fmt.Sprintf("/proc/%d/comm", pid))
	if err != nil {
		return false, nil
	}
	return strings.TrimSpace(comm) == "sshd", nil
}

// waitForServiceState 启停后轮询 pidfile 直至到达目标态：TERM 与守护进程化都异步
// 生效，立即回查会带回过期运行态，面板的开关会被拉回旧值。预算（50×100ms）内
// 未收敛返回 false，由调用方如实报错。
func (s *sshService) waitForServiceState(running bool) (bool, error) {
	const attempts = 50
	for attempt := 0; attempt < attempts; attempt++ {
		current, err := s.serviceRunning()
		if err != nil {
			return false, err
		}
		if current == running {
			return true, nil
		}
		s.deps.delay(100)
	}
	current, err := s.serviceRunning()
	return current == running, err
}

// serviceAliveAfterReload SIGHUP 重载后确认 sshd 存活：重载触发 re-exec 重读配置，
// 端口被占用这类只在真实监听时暴露的致命问题会让进程直接退出并清掉 pidfile。
// 短轮询一个窗口（10×100ms），期间任何一次探测发现不在跑即判定死亡，交由调用方
// 回滚原文。
func (s *sshService) serviceAliveAfterReload() (bool, error) {
	const attempts = 10
	for attempt := 0; attempt < attempts; attempt++ {
		running, err := s.serviceRunning()
		if err != nil {
			return false, err
		}
		if !running {
			return false, nil
		}
		s.deps.delay(100)
	}
	return s.serviceRunning()
}

// readConfigText 读主配置原文。
func (s *sshService) readConfigText() (string, error) {
	text, err := s.deps.readText(s.paths.sshdConfig)
	if err != nil {
		return "", fmt.Errorf("无法读取 sshd 配置（%s）：%v", s.paths.sshdConfig, err)
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

// writeAtomic 备份 + 临时文件 + rename 的原子写：任何时刻目标路径上要么是旧全文
// 要么是新全文。original 为 nil 时不写备份（回滚路径：.bak 已是原文）。
func (s *sshService) writeAtomic(target string, original *string, next string) error {
	return s.writeAtomicOwned(target, original, next, nil)
}

func (s *sshService) writeAtomicOwned(target string, original *string, next string, owner *PasswdEntry) error {
	tmp := target + ".elysian-tmp"
	if err := s.refuseSymlink(tmp, "原子写的临时文件"); err != nil {
		return err
	}
	if original != nil {
		if err := s.refuseSymlink(target+".bak", "写前备份"); err != nil {
			return err
		}
		if err := s.deps.writeText(target+".bak", *original); err != nil {
			return err
		}
	}
	if err := s.deps.writeText(tmp, next); err != nil {
		return err
	}
	if s.deps.copyMetadata != nil && s.deps.exists(target) {
		if err := s.deps.copyMetadata(target, tmp); err != nil {
			return err
		}
	}
	if owner != nil {
		if err := s.deps.chmod(tmp, 0o600); err != nil {
			return err
		}
		if err := s.deps.chown(tmp, owner.UID, owner.GID); err != nil {
			return err
		}
	}
	return s.deps.rename(tmp, target)
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
			return fmt.Errorf("%v；已恢复 SSH 原配置和服务状态", cause)
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

// loginLineAt 无时间戳的日志行（sshd -E 裸行）→ 本次会话首次观察到的时间。
func (s *sshService) loginLineAt(line ParsedLoginLine) string {
	if line.At != nil {
		return *line.At
	}
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	at, ok := s.loginLineFirstSeenAt[line.Source]
	if !ok {
		at = s.deps.nowIso()
		s.loginLineFirstSeenAt[line.Source] = at
	}
	return at
}

// loginRecords 解析登录日志（存在才读，只读尾部 512 KiB 预算）。
func (s *sshService) loginRecords() ([]SshLoginRecord, error) {
	if !s.deps.exists(s.paths.sshdLog) {
		return []SshLoginRecord{}, nil
	}
	text, err := s.deps.readTextTail(s.paths.sshdLog, SSH_LOG_TAIL_BYTES)
	if err != nil {
		return nil, err
	}
	parsed := ParseSshLog(text, s.deps.nowIso())
	records := make([]SshLoginRecord, 0, len(parsed))
	for index, line := range parsed {
		records = append(records, SshLoginRecord{
			ID:     fmt.Sprintf("login-%d", index+1),
			IP:     line.IP,
			Port:   line.Port,
			At:     s.loginLineAt(line),
			User:   line.User,
			Result: line.Result,
		})
	}
	return records, nil
}

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

// Overview 服务概况：enabled 与 status 都映射 sshd 是否在跑（pidfile 探测），
// changedAt 取宿主时间戳文件（从未由面板启停过为 null）。
func (s *sshService) Overview() (SshOverview, error) {
	running, err := s.serviceRunning()
	if err != nil {
		return SshOverview{}, err
	}
	var stats SshLoginStats
	var logInfo *SshLogInfo
	if s.deps.loginHistory != nil {
		snapshot := s.deps.loginHistory()
		stats = snapshot.Stats
		logInfo = snapshot.Info
	} else {
		records, e := s.loginRecords()
		if e != nil {
			return SshOverview{}, e
		}
		stats = SummarizeSshLog(records, s.deps.nowIso())
	}
	status := "stopped"
	if running {
		status = "running"
	}
	return SshOverview{
		Enabled:     running,
		Status:      status,
		ChangedAt:   s.readStamp(s.paths.changedAtStamp),
		Stats:       stats,
		RuntimeMode: s.deps.runtimeMode, LogInfo: logInfo,
	}, nil
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

// SetServiceEnabled 通过注入的裸机 systemd 或容器 sshd 控制器启停，核实后才更新变更时间。
func (s *sshService) SetServiceEnabled(enabled bool) (SshOverview, error) {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	if enabled && s.deps.validateRuntime != nil {
		if err := s.deps.validateRuntime(); err != nil {
			return SshOverview{}, err
		}
	}
	if s.deps.setEnabled != nil {
		if err := s.deps.setEnabled(enabled); err != nil {
			return SshOverview{}, err
		}
	} else {
		running, err := s.serviceRunning()
		if err != nil {
			return SshOverview{}, err
		}
		if enabled && !running {
			if err = s.deps.startSshd(); err != nil {
				return SshOverview{}, fmt.Errorf("启动 sshd 失败：%w", err)
			}
		}
		if !enabled {
			if err = s.deps.stopSshd(); err != nil {
				return SshOverview{}, fmt.Errorf("停止 sshd 失败：%w", err)
			}
		}
	}
	ok, err := s.waitForServiceState(enabled)
	if err != nil {
		return SshOverview{}, err
	}
	if !ok {
		return SshOverview{}, fmt.Errorf("SSH 启停未生效：服务状态未在预期时间内收敛，请刷新核对实际状态")
	}
	if enabled && s.deps.verifyConfig != nil {
		settings, e := s.Settings()
		if e != nil {
			return SshOverview{}, e
		}
		if e = s.deps.verifyConfig(settings.Port); e != nil {
			return SshOverview{}, e
		}
	}
	if err = s.writeStamp(s.paths.changedAtStamp, s.deps.nowIso()); err != nil {
		return SshOverview{}, err
	}
	return s.Overview()
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
		return SshPasswordResetResult{}, fmt.Errorf("chpasswd 执行失败：%v", err)
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

// ListLoginRecords 登录记录：日志按时间顺序解析，界面按时间倒序呈现。
func (s *sshService) ListLoginRecords() ([]SshLoginRecord, error) {
	if s.deps.loginHistory != nil {
		return s.deps.loginHistory().Records, nil
	}
	records, err := s.loginRecords()
	if err != nil {
		return nil, err
	}
	reversed := make([]SshLoginRecord, 0, len(records))
	for i := len(records) - 1; i >= 0; i-- {
		reversed = append(reversed, records[i])
	}
	return reversed, nil
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

// sharedInvalidRequest shared.InvalidRequest 的短别名（本文件高频使用）。
func sharedInvalidRequest(message string) error {
	return shared.InvalidRequest(message)
}
