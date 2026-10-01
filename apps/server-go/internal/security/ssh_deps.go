package security

// SSH 真实管理的宿主接线（sshd/ssh-keygen/chpasswd/getent；sshHostDeps.ts 的 Go
// 等价物）。硬边界由装配层注入的 Deps.Available 决定（go-plan §5：LocalDemo 整片
// 503、Docker/BareMetal 直接执行），域包不读 env、不读 /.dockerenv。
//
// 安全红线：所有命令数组传参执行，绝不拼 shell 字符串；写文件与 chmod/chown 一律
// O_NOFOLLOW 作用于句柄——root 的动作永不跟随最终组件的符号链接（中间组件如
// ~/.Elysian → 持久卷不受影响）。

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strings"
	"syscall"
	"time"

	"elysian/server/internal/paths"
)

// sshPaths 面板落盘的全部路径（DEFAULT_SSH_PATHS 的等价物；测试可整体替换）。
type sshPaths struct {
	sshdConfig           string
	sshdLog              string
	sshdPidFile          string
	keygenWorkspace      string
	changedAtStamp       string
	passwordResetAtStamp string
}

// defaultSshPaths 按当前 home 与系统路径计算的缺省路径表。
func defaultSshPaths() sshPaths {
	return sshPaths{
		sshdConfig:           "/etc/ssh/sshd_config",
		sshdLog:              paths.Default.SshdLog,
		sshdPidFile:          "/run/sshd.pid",
		keygenWorkspace:      paths.Default.KeygenWorkspace,
		changedAtStamp:       paths.Default.SshChangedAt,
		passwordResetAtStamp: paths.Default.SshRootPasswordResetAt,
	}
}

// SSH_LOG_TAIL_BYTES 登录日志按字节取尾的预算：远大于 2000 行常规行宽的总量，
// 超预算的旧段不再读进内存——截尾发生在读取层而不是整读之后。
const SSH_LOG_TAIL_BYTES = 512 * 1024

// sshHostDeps 服务编排的全部宿主访问面（函数字段全部可注入，测试用内存实现驱动）。
type sshHostDeps struct {
	runSshKeygen  func(args []string) (string, error)
	runSshd       func(args []string) (string, error)
	startSshd     func() error
	stopSshd      func() error
	reloadSshd    func() error
	runChpasswd   func(input string) (string, error)
	runGetent     func(args []string) (string, error)
	delay         func(ms int)
	readText      func(path string) (string, error)
	readTextTail  func(path string, maxBytes int64) (string, error)
	readDir       func(path string) ([]string, error)
	writeText     func(path, content string) error
	exists        func(path string) bool
	lstat         func(path string) (bool, error)
	rename        func(from, to string) error
	chmod         func(path string, mode uint32) error
	chown         func(path string, uid, gid int) error
	mkdir         func(path string) error
	remove        func(path string) error
	nowIso        func() string
	pathsOverride *sshPaths
}

// execDetail 子进程失败 → 中文错误详情：优先带 stderr（trim 后非空），没有时回退
// 错误消息本身；命令上下文由服务层拼装。
func execDetail(err error) string {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && len(exitErr.Stderr) > 0 {
		if detail := strings.TrimSpace(string(exitErr.Stderr)); detail != "" {
			return detail
		}
	}
	return err.Error()
}

// execToStdout 执行命令并返回 stdout；失败抛带 stderr 详情的错误。
func execToStdout(name string, args []string) (string, error) {
	cmd := exec.Command(name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", errors.New(execDetail(err))
	}
	return stdout.String(), nil
}

// ---------- pidfile 与进程身份核实 ----------

// sshdPidProbe pidfile 与进程身份核实的注入面：测试用内存实现驱动。
type sshdPidProbe struct {
	readPidFile  func() (string, bool)
	readProcComm func(pid int) (string, bool)
}

// resolveVerifiedSshdPid 解析并核实 sshd 主进程 pid：pidfile 读不出、pid 非法，
// 或 /proc/<pid>/comm 不是 sshd（进程已退出、pid 被无关进程复用）都返回 false——
// 信号只发给核实过身份的 sshd，杜绝按陈旧 pidfile 误杀无关进程。
func resolveVerifiedSshdPid(probe sshdPidProbe) (int, bool) {
	text, ok := probe.readPidFile()
	if !ok {
		return 0, false
	}
	pid, valid := jsParseInt(strings.TrimSpace(text))
	if !valid {
		return 0, false
	}
	comm, ok := probe.readProcComm(pid)
	if !ok {
		return 0, false
	}
	if strings.TrimSpace(comm) == "sshd" {
		return pid, true
	}
	return 0, false
}

// createPidProbe 容器内真实探针：pidfile 与 /proc/<pid>/comm 都按只读探测，
// 读不到返回 false。
func createPidProbe() sshdPidProbe {
	return sshdPidProbe{
		readPidFile: func() (string, bool) {
			data, err := os.ReadFile(defaultSshPaths().sshdPidFile)
			if err != nil {
				return "", false
			}
			return string(data), true
		},
		readProcComm: func(pid int) (string, bool) {
			data, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
			if err != nil {
				return "", false
			}
			return string(data), true
		},
	}
}

// signalSshd 向核实过身份的 sshd 主进程发信号；失败抛中文错误，由调用方决定如何呈现。
// 信号名按 TS 版字面（SIGTERM/SIGHUP），不取 Go 的 Signal.String()。
func signalSshd(pid int, signalName string, sig syscall.Signal) error {
	if err := syscall.Kill(pid, sig); err != nil {
		return fmt.Errorf("向 sshd（pid %d）发送 %s 失败：%v", pid, signalName, err)
	}
	return nil
}

// ---------- 只读文件末段 ----------

// readTextTailFromFile 只读文件末段（最多 maxBytes 字节）：登录日志按尾读取，
// 大文件不整读进堆。从文件中部起读（发生截断）时丢弃不完整的首行——截断可能
// 恰好落在一条完整消息的中间，不丢会凭空多出一条无时间戳的记录。
func readTextTailFromFile(path string, maxBytes int64) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	size := info.Size()
	start := size - maxBytes
	if start < 0 {
		start = 0
	}
	buf := make([]byte, size-start)
	if _, err := f.ReadAt(buf, start); err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return textTailOf(string(buf), start > 0), nil
}

// textTailOf 字节尾读的纯函数核心：start 之后的内容丢掉首个 \n 之前的不完整首行
// （无 \n 则整段丢弃）。
func textTailOf(tail string, truncated bool) string {
	if !truncated {
		return tail
	}
	idx := strings.IndexByte(tail, '\n')
	if idx < 0 {
		return ""
	}
	return tail[idx+1:]
}

// ---------- O_NOFOLLOW 文件原语 ----------

// writeTextNoFollow 写文件且不跟随最终组件的符号链接：链接占位即失败（ELOOP），
// 绝不写穿到链接目标。
func writeTextNoFollow(path, content string) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC|syscall.O_NOFOLLOW, 0o666)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := io.WriteString(f, content); err != nil {
		return err
	}
	return f.Close()
}

// chmodNoFollow 以句柄收紧权限且不跟随最终组件的符号链接：权限绝不落到链接目标上。
func chmodNoFollow(path string, mode uint32) error {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Chmod(os.FileMode(mode))
}

// chownNoFollow 以句柄落属主且不跟随最终组件的符号链接：属主绝不落到链接目标上。
func chownNoFollow(path string, uid, gid int) error {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Chown(uid, gid)
}

// isSymbolicLink 窄化的 lstat 判定：只暴露「最终组件是否符号链接」；路径不存在
// 同样按「不是链接」返回（错误带回给调用方按探测失败放行）。
func isSymbolicLink(path string) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return false, err
	}
	return info.Mode()&os.ModeSymlink != 0, nil
}

// ---------- chpasswd（凭据只走 stdin，密码不进命令行参数） ----------

// chpasswdChild chpasswd 子进程的最小形状：三路管道与等待结果。
type chpasswdChild interface {
	// Stdin 标准输入写端；nil 表示管道未建立。
	Stdin() io.WriteCloser
	// Stdout 标准输出读端；nil 表示管道未建立。
	Stdout() io.Reader
	// Stderr 标准错误读端；nil 表示管道未建立。
	Stderr() io.Reader
	// Wait 等待退出；非 nil 表示非零退出或等待失败。
	Wait() error
	// ExitCode 退出码；被信号杀死（JS close 事件的 code=null）返回 -1。
	ExitCode() int
}

// spawnChpasswdLike 启动 chpasswd 子进程；启动失败（如可执行文件不存在）返回错误。
type spawnChpasswdLike func() (chpasswdChild, error)

// runChpasswdViaStdin chpasswd 凭据只走 stdin：spawn 后把 `账号:密码` 写进标准
// 输入，密码不进命令行。stdin 写失败（EPIPE 等，chpasswd 在读 stdin 前退出时）
// 同步返回错误（TS 侧是异步事件接住，行为等价：错误带回、不打崩进程）；退出码
// 非 0 时错误信息取 stderr trim，无 stderr 回退 `chpasswd 退出码 <code>`（被信号
// 杀死记 unknown）；stdio 未建立 → 中文错误。
func runChpasswdViaStdin(spawnChpasswd spawnChpasswdLike, input string) (string, error) {
	child, spawnErr := spawnChpasswd()
	if spawnErr != nil {
		return "", spawnErr
	}
	stdin, stdout, stderrPipe := child.Stdin(), child.Stdout(), child.Stderr()
	if stdin == nil || stdout == nil || stderrPipe == nil {
		return "", errors.New("chpasswd 子进程的标准管道未建立")
	}
	var stderr bytes.Buffer
	drained := make(chan struct{})
	go func() {
		_, _ = io.Copy(&stderr, stderrPipe)
		close(drained)
	}()
	go func() {
		_, _ = io.Copy(io.Discard, stdout)
	}()
	if _, err := io.WriteString(stdin, input); err != nil {
		return "", err
	}
	if err := stdin.Close(); err != nil {
		return "", err
	}
	waitErr := child.Wait()
	<-drained
	if waitErr == nil {
		return "", nil
	}
	if detail := strings.TrimSpace(stderr.String()); detail != "" {
		return "", errors.New(detail)
	}
	code := child.ExitCode()
	if code < 0 {
		return "", errors.New("chpasswd 退出码 unknown")
	}
	return "", fmt.Errorf("chpasswd 退出码 %d", code)
}

// execChpasswdChild 真实 chpasswd 子进程（exec.Command 封装成 chpasswdChild）。
type execChpasswdChild struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr io.ReadCloser
}

// Stdin 标准输入写端。
func (c *execChpasswdChild) Stdin() io.WriteCloser { return c.stdin }

// Stdout 标准输出读端。
func (c *execChpasswdChild) Stdout() io.Reader { return c.stdout }

// Stderr 标准错误读端。
func (c *execChpasswdChild) Stderr() io.Reader { return c.stderr }

// Wait 等待退出。
func (c *execChpasswdChild) Wait() error { return c.cmd.Wait() }

// ExitCode 退出码（-1 = 被信号杀死）。
func (c *execChpasswdChild) ExitCode() int {
	if c.cmd.ProcessState == nil {
		return -1
	}
	return c.cmd.ProcessState.ExitCode()
}

// spawnChpasswdPipe 真实 spawn 接线：stdio 三路 pipe。
func spawnChpasswdPipe() (chpasswdChild, error) {
	cmd := exec.Command("chpasswd")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &execChpasswdChild{cmd: cmd, stdin: stdin, stdout: stdout, stderr: stderr}, nil
}

// ---------- 真实接线 ----------

// newRealSshDeps 容器内真实依赖：全部宿主访问经数组传参命令与 O_NOFOLLOW 原语。
func newRealSshDeps(now func() time.Time, override *sshPaths) *sshHostDeps {
	return &sshHostDeps{
		runSshKeygen: func(args []string) (string, error) { return execToStdout("ssh-keygen", args) },
		runSshd:      func(args []string) (string, error) { return execToStdout("/usr/sbin/sshd", args) },
		startSshd: func() error {
			// 带 -E 启动：sshd 自行 daemonize 并写 pidfile，日志持续落到面板读取的文件。
			// 不走 service ssh start——容器里 /etc/default/ssh 的 SSHD_OPTS 为空，那样丢 -E 日志。
			p := sshDepsPaths(override)
			_, err := execToStdout("/usr/sbin/sshd", []string{"-E", p.sshdLog})
			return err
		},
		stopSshd: func() error {
			// pid 复用防线：TERM 只发给核实过身份（/proc/<pid>/comm 为 sshd）的进程；
			// pidfile 陈旧或 pid 被复用时按未在跑处理，幂等成功。
			pid, ok := resolveVerifiedSshdPid(createPidProbe())
			if !ok {
				return nil
			}
			return signalSshd(pid, "SIGTERM", syscall.SIGTERM)
		},
		reloadSshd: func() error {
			// SIGHUP 同样只发核实过身份的进程；pid 不在时静默返回（无需重载）。
			// SIGHUP：sshd 重读配置并 re-exec 自身，-E 等启动参数原样保留；不走 restart。
			pid, ok := resolveVerifiedSshdPid(createPidProbe())
			if !ok {
				return nil
			}
			return signalSshd(pid, "SIGHUP", syscall.SIGHUP)
		},
		runChpasswd: func(input string) (string, error) {
			return runChpasswdViaStdin(spawnChpasswdPipe, input)
		},
		runGetent: func(args []string) (string, error) { return runGetentReal(args) },
		delay:     func(ms int) { time.Sleep(time.Duration(ms) * time.Millisecond) },
		readText: func(path string) (string, error) {
			data, err := os.ReadFile(path)
			if err != nil {
				return "", err
			}
			return string(data), nil
		},
		readTextTail: func(path string, maxBytes int64) (string, error) {
			return readTextTailFromFile(path, maxBytes)
		},
		readDir: func(path string) ([]string, error) {
			// 目录不存在（未建 sshd_config.d）时按空处理：Include 通配展开据此得到零个文件。
			entries, err := os.ReadDir(path)
			if err != nil {
				return nil, nil
			}
			names := make([]string, 0, len(entries))
			for _, entry := range entries {
				names = append(names, entry.Name())
			}
			sort.Strings(names)
			return names, nil
		},
		writeText: func(path, content string) error { return writeTextNoFollow(path, content) },
		exists:    func(path string) bool { _, err := os.Stat(path); return err == nil },
		lstat:     isSymbolicLink,
		rename:    os.Rename,
		chmod:     chmodNoFollow,
		chown:     chownNoFollow,
		mkdir:     func(path string) error { return os.MkdirAll(path, 0o755) },
		remove: func(path string) error {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			return nil
		},
		nowIso: func() string {
			t := time.Now()
			if now != nil {
				t = now()
			}
			return formatIsoMillis(t)
		},
		pathsOverride: override,
	}
}

// newRealSshDepsWithWorkspace 真实依赖 + 启动即建密钥工作目录：请求路径上少一次
// 可失败的副作用；创建失败仅落 stderr 诊断，不阻断装配。
func newRealSshDepsWithWorkspace(now func() time.Time, override *sshPaths) *sshHostDeps {
	deps := newRealSshDeps(now, override)
	if err := os.MkdirAll(sshDepsPaths(override).keygenWorkspace, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "[elysian] SSH 密钥工作目录创建失败：%v\n", err)
	}
	return deps
}

// sshDepsPaths 取依赖生效的路径表（nil 覆盖 → 缺省）。
func sshDepsPaths(override *sshPaths) sshPaths {
	if override != nil {
		return *override
	}
	return defaultSshPaths()
}

// formatIsoMillis time → JS toISOString 等价格式（UTC、3 位毫秒）。
func formatIsoMillis(t time.Time) string {
	return t.UTC().Format(isoMillisLayout)
}
