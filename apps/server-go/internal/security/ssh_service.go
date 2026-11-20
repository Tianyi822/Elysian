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
	"fmt"
	"strings"
	"sync"
	"sync/atomic"

	"elysian/server/internal/shared"
)

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

// commandError 命令失败的统一包装：detail 优先取 stderr（真实接线已归一为错误
// 消息），`${command} 执行失败（${完整命令行}）：${detail}`。
func (s *sshService) commandError(command string, args []string, err error) error {
	full := append([]string{command}, args...)
	return fmt.Errorf("%s 执行失败（%s）：%w", command, strings.Join(full, " "), err)
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

// sharedInvalidRequest shared.InvalidRequest 的短别名（本文件高频使用）。
func sharedInvalidRequest(message string) error {
	return shared.InvalidRequest(message)
}
