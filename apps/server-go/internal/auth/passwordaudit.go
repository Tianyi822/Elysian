package auth

import (
	"encoding/json"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"elysian/server/internal/paths"
	"elysian/server/internal/shared"
)

// 改密安全审计：面板密码的两条改密线各落一条持久记录——HTTP（POST /api/auth/password，
// 生产恒在 RequireSession 之下，执行主体是已登录管理员）与本机 CLI（elysian resetpwd 与
// ely 菜单同一入口 RunResetPasswordCLIAt，执行主体是当前 OS 用户）。记录只含执行主体、
// 时间、来源与结果；失败原因只取域内固定中文文案或 errno 归因（errorReason），绝不写入
// 密码明文、哈希或任何可还原敏感内容。
//
// 落点取舍：logs 域的 logs.sqlite 是操作日志的权威库，但它经装配层单实例打开，auth 域按
// 「域间只经 seam 对话」的边界不得直接依赖 logs 域，且 CLI 进程没有那条装配线、也不做
// 跨进程 sqlite 写。因此记录由 auth 域按「面板自管数据」约定自持：JSONL 追加写
// <panelHome>/logs/panel-password-audit.jsonl（缺省路径登记在 paths.Default.PanelPasswordAudit，
// CLI 侧与凭据文件同一注入根解析），文件 0600、目录 0700。HTTP 侧既有操作日志（logs 域
// 审计中间件对 POST /api/auth/password 的 success/failure 与时间）保持不变，本文件补齐
// 执行主体、来源与失败原因。审计写盘失败只落 stderr 诊断，绝不改变改密主流程的结果语义
// （HTTP 响应与 CLI 退出码均不受影响，对齐 logs 域 safeWrite 的降级纪律）。
//
// 保留策略对齐既有日志口径：30 天（操作/登录日志的保留天数）加 1 MiB 体积兜底（改密是
// 人工频次事件，上限只防文件失控增长）。整理在每次写入后按需触发：文件超体积上限或首条
// 记录已过保留窗口时，按行保留未过期且不超上限的最新一段并原子重写。

const (
	// PasswordAuditSourcePanelHTTP 已登录管理员的 HTTP 改密（POST /api/auth/password）。
	PasswordAuditSourcePanelHTTP = "panel-http"
	// PasswordAuditSourceCLIResetPwd 本机 CLI 改密：elysian resetpwd 与 ely 菜单同一改密线。
	PasswordAuditSourceCLIResetPwd = "cli-resetpwd"

	// passwordAuditResultSuccess / passwordAuditResultFailure 结果取值（与操作日志 result 同词）。
	passwordAuditResultSuccess = "success"
	passwordAuditResultFailure = "failure"

	// passwordAuditRetention 保留窗口：30 天（对齐操作/登录日志保留天数）。
	passwordAuditRetention = 30 * 24 * time.Hour
	// passwordAuditMaxBytes 单文件体积上限：1 MiB（防失控兜底，正常频次远达不到）。
	passwordAuditMaxBytes = 1024 * 1024
	// passwordAuditReasonMaxLength 失败原因上限（UTF-16 计，对齐操作日志 summary 上限）。
	passwordAuditReasonMaxLength = 200
	// passwordAuditActorMaxLength 执行主体上限（UTF-16 计）。
	passwordAuditActorMaxLength = 100
	// isoMillisLayout 毫秒精度 ISO 串布局（与 isoNowMillis/formatISOMillis 同形）。
	isoMillisLayout = "2006-01-02T15:04:05.000Z"
)

// PasswordAuditRecord 一条改密审计记录；键序即 JSONL 输出序。At 是毫秒精度 ISO 串
// （恒 UTC），Source 取 PasswordAuditSource* 两个常量，Actor 是执行主体（HTTP=admin、
// CLI=<用户名>(<uid>)），Result 取 success/failure，Reason 仅失败时携带中文原因（脱敏）。
type PasswordAuditRecord struct {
	At     string `json:"at"`
	Source string `json:"source"`
	Actor  string `json:"actor"`
	Result string `json:"result"`
	Reason string `json:"reason,omitempty"`
}

// PasswordAuditSink 改密安全审计出口：RecordPasswordChange 绝不返回错误——写盘失败在实现
// 内部只落诊断，不得影响改密主流程。HTTP 端点经 Deps.PasswordAudit 注入（nil 落文件版），
// 测试注入内存版；CLI 线直接构造文件版（按注入 panelHome 对准生产根）。
type PasswordAuditSink interface {
	RecordPasswordChange(record PasswordAuditRecord)
}

// buildPasswordAuditRecord 构造并净化一条审计记录：执行主体与失败原因单行化（控制字符与
// 换行换空格）并按 UTF-16 上限截断，防止任何调用方把多行内容注入 JSONL 行结构；At、Source
// 与 Result 取自域内固定值，不经外部输入。
func buildPasswordAuditRecord(at, source, actor, result, reason string) PasswordAuditRecord {
	return PasswordAuditRecord{
		At:     sanitizePasswordAuditField(at, passwordAuditReasonMaxLength),
		Source: source,
		Actor:  sanitizePasswordAuditField(actor, passwordAuditActorMaxLength),
		Result: result,
		Reason: sanitizePasswordAuditField(reason, passwordAuditReasonMaxLength),
	}
}

// sanitizePasswordAuditField 单行化（C0/C1 控制、DEL 与行分隔符换空格）、连续空白压成
// 一个空格、去首尾空白 + UTF-16 口径截断（净化面与 logs 域 NormalizeSingleLine 同纪律）。
func sanitizePasswordAuditField(text string, maxLength int) string {
	var replaced strings.Builder
	replaced.Grow(len(text))
	space := false
	for _, r := range text {
		if r <= 0x1F || (r >= 0x7F && r <= 0x9F) || r == 0x2028 || r == 0x2029 || r == ' ' {
			// 控制字符、行分隔符与既有空白统一折成一个空格。
			if !space {
				replaced.WriteRune(' ')
				space = true
			}
			continue
		}
		replaced.WriteRune(r)
		space = false
	}
	normalized := strings.TrimSpace(replaced.String())
	var truncated strings.Builder
	units := 0
	for _, r := range normalized {
		width := 1
		if r > 0xFFFF {
			width = 2
		}
		if units+width > maxLength {
			break
		}
		truncated.WriteRune(r)
		units += width
	}
	return truncated.String()
}

// passwordAuditCLIActor CLI 线执行主体：`<用户名>(<uid>)`；用户名不可得时退回 `uid=<uid>`。
func passwordAuditCLIActor() string {
	uid := os.Getuid()
	if current, err := user.Current(); err == nil && current.Username != "" {
		return fmt.Sprintf("%s(%d)", current.Username, uid)
	}
	return fmt.Sprintf("uid=%d", uid)
}

// recordPasswordChange 落一条 HTTP 线（panel-http）的改密审计：at 取注入时钟，执行主体是
// 单用户面板的固定管理员——本方法只被 RequireSession 之下的设置端点调用，生产语义即
// 「已登录管理员」。
func (r resolvedDeps) recordPasswordChange(result, reason string) {
	r.passwordAudit.RecordPasswordChange(buildPasswordAuditRecord(
		r.now().UTC().Format(isoMillisLayout),
		PasswordAuditSourcePanelHTTP,
		PanelUsername,
		result,
		reason,
	))
}

// NewFilePasswordAudit 文件版改密审计；path 传空串时用 paths.Default.PanelPasswordAudit
// 缺省路径（~/.Elysian/logs/panel-password-audit.jsonl）。构造无 IO，首次写入时建目录。
func NewFilePasswordAudit(path string) PasswordAuditSink {
	if path == "" {
		path = paths.Default.PanelPasswordAudit
	}
	return &filePasswordAudit{
		path:      path,
		now:       time.Now,
		retention: passwordAuditRetention,
		maxBytes:  passwordAuditMaxBytes,
	}
}

// filePasswordAudit JSONL 追加写的文件版审计；进程内互斥（面板与 CLI 是两个进程，各自
// 实例的 O_APPEND 单次写不会交错出行内碎片——改密是人工频次事件，跨进程并发窗口可忽略）。
type filePasswordAudit struct {
	path      string
	now       func() time.Time
	retention time.Duration
	maxBytes  int64
	mu        sync.Mutex
}

// RecordPasswordChange 追加一条记录并按需整理保留；一切失败（序列化、写盘、整理）只落
// stderr 诊断。panic 兜底与 logs 域 safeWrite 同纪律：审计绝不把故障放大回改密主流程。
func (a *filePasswordAudit) RecordPasswordChange(record PasswordAuditRecord) {
	defer func() {
		if rec := recover(); rec != nil {
			fmt.Fprintf(os.Stderr, "Elysian 改密审计写入失败：%v\n", rec)
		}
	}()
	a.mu.Lock()
	defer a.mu.Unlock()
	line, err := shared.MarshalJSON(PasswordAuditRecord{
		At:     sanitizePasswordAuditField(record.At, passwordAuditReasonMaxLength),
		Source: record.Source,
		Actor:  sanitizePasswordAuditField(record.Actor, passwordAuditActorMaxLength),
		Result: record.Result,
		Reason: sanitizePasswordAuditField(record.Reason, passwordAuditReasonMaxLength),
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Elysian 改密审计序列化失败：%v\n", err)
		return
	}
	// 追加与裁剪共享独立锁文件；不能锁会被原子重命名替换的 JSONL inode。
	if err := os.MkdirAll(filepath.Dir(a.path), 0700); err != nil {
		fmt.Fprintf(os.Stderr, "改密审计目录失败：%v\n", err)
		return
	}
	lock, err := os.OpenFile(a.path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		fmt.Fprintf(os.Stderr, "改密审计锁失败：%v\n", err)
		return
	}
	defer lock.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if time.Now().After(deadline) || (err != syscall.EWOULDBLOCK && err != syscall.EAGAIN) {
			fmt.Fprintf(os.Stderr, "改密审计锁失败：%v\n", err)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	if err := a.append(line); err != nil {
		fmt.Fprintf(os.Stderr, "Elysian 改密审计写入失败（%s）：%v\n", a.path, err)
		return
	}
	if err := a.prune(); err != nil {
		fmt.Fprintf(os.Stderr, "Elysian 改密审计保留整理失败（%s）：%v\n", a.path, err)
	}
}

// append 建目录（0700）后以 O_APPEND|O_CREATE（0600）追加一行并 fsync——审计是安全事实，
// 落盘即同步。
func (a *filePasswordAudit) append(line []byte) error {
	if err := os.MkdirAll(filepath.Dir(a.path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(a.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	payload := make([]byte, 0, len(line)+1)
	payload = append(payload, line...)
	payload = append(payload, '\n')
	if _, err := file.Write(payload); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

// prune 保留整理：文件超体积上限或首条记录已过保留窗口才动作；按行保留「未过期且合计不超
// 上限」的最新一段，经 writeFileAtomic 原子重写。无行可删时不重写；整理失败不回滚（追加
// 记录已落盘），由调用方诊断。
func (a *filePasswordAudit) prune() error {
	info, err := os.Stat(a.path)
	if err != nil {
		return err
	}
	cutoff := a.now().UTC().Add(-a.retention).Format(isoMillisLayout)
	if info.Size() <= a.maxBytes && !a.headStale(cutoff) {
		return nil
	}
	data, err := os.ReadFile(a.path)
	if err != nil {
		return err
	}
	lines := strings.Split(string(data), "\n")
	nonEmpty := 0
	for _, line := range lines {
		if strings.TrimSpace(line) != "" {
			nonEmpty++
		}
	}
	// 从最新往旧收集：过期的整行丢弃，未过期但塞不进上限的从旧侧截断。
	kept := make([]string, 0, nonEmpty)
	var keptBytes int64
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		if at := passwordAuditLineAt(line); at != "" && at < cutoff {
			continue
		}
		if keptBytes+int64(len(line))+1 > a.maxBytes {
			break
		}
		kept = append(kept, line)
		keptBytes += int64(len(line)) + 1
	}
	if len(kept) == nonEmpty {
		return nil
	}
	var out strings.Builder
	for i := len(kept) - 1; i >= 0; i-- {
		out.WriteString(kept[i])
		out.WriteByte('\n')
	}
	return writeFileAtomic(a.path, []byte(out.String()))
}

// headStale 首条记录的 at 是否已过保留窗口（文件头读一小段即可判定；解析不出 at 时保守
// 回 false，交由体积上限兜底）。
func (a *filePasswordAudit) headStale(cutoff string) bool {
	file, err := os.Open(a.path)
	if err != nil {
		return false
	}
	defer file.Close()
	head := make([]byte, 8*1024)
	n, _ := file.Read(head)
	for _, line := range strings.Split(string(head[:n]), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		at := passwordAuditLineAt(line)
		return at != "" && at < cutoff
	}
	return false
}

// passwordAuditLineAt 取一行 JSONL 的 at；坏行回空串。
func passwordAuditLineAt(line string) string {
	var record struct {
		At string `json:"at"`
	}
	if err := json.Unmarshal([]byte(line), &record); err != nil {
		return ""
	}
	return record.At
}

// NewMemoryPasswordAudit 内存版改密审计（测试用）：按序记录全部入参供断言，不做任何净化。
func NewMemoryPasswordAudit() *memoryPasswordAudit {
	return &memoryPasswordAudit{}
}

type memoryPasswordAudit struct {
	mu      sync.Mutex
	records []PasswordAuditRecord
}

// RecordPasswordChange 实现 PasswordAuditSink。
func (m *memoryPasswordAudit) RecordPasswordChange(record PasswordAuditRecord) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.records = append(m.records, record)
}

// Records 已落记录的副本（时间序）。
func (m *memoryPasswordAudit) Records() []PasswordAuditRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	copied := make([]PasswordAuditRecord, len(m.records))
	copy(copied, m.records)
	return copied
}
