package firewall

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// 真实防火墙服务层的接线（firewallHostDeps.ts 等价物）：ufw/ss/iptables/ip6tables 经
// exec 直接执行（非 shell），错误优先取 stderr 作 detail；规则时间账本打开失败不拖垮
// 端点，退回会话账本；容器重启后内核规则已失而 ufw.conf 仍记 ENABLED=yes 时，启动
// restoreIfNeeded（fire-and-forget，失败只落 stderr 诊断）。

// execHostDeps 生产接线。
type execHostDeps struct {
	fwPaths FirewallPaths
	times   ruleTimes
	now     func() time.Time
}

// execToStdout 执行命令取 stdout；失败时 detail 优先取 stderr.trim()，否则错误消息。
func execToStdout(name string, args []string) (string, error) {
	cmd := exec.Command(name, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		detail := trimSpaceJS(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return "", errors.New(detail)
	}
	return string(out), nil
}

func trimSpaceJS(s string) string {
	// 与 JS 的 String.prototype.trim 对齐的常用空白集合即可：这里只服务 stderr 清理。
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t' || s[0] == '\n' || s[0] == '\r' || s[0] == '\v' || s[0] == '\f') {
		s = s[1:]
	}
	for len(s) > 0 {
		c := s[len(s)-1]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f' {
			s = s[:len(s)-1]
			continue
		}
		break
	}
	return s
}

// newExecHostDeps 构造生产接线。dbPath 非空时打开（或创建）规则时间账本；打开失败
// 落 stderr 诊断并降级为纯会话账本（不拖垮端点）。now 为 nil 用 time.Now。
func newExecHostDeps(dbPath string, now func() time.Time) hostDeps {
	if now == nil {
		now = time.Now
	}
	var times ruleTimes
	if dbPath != "" {
		// 账本目录由 compose 启动命令预建；这里补一次 MkdirAll 属行为放宽，
		// 与 TS 版「目录缺失时打开失败并降级」不冲突（打开仍失败时同样降级）。
		if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err == nil {
			store, err := openRuleTimesStore(dbPath)
			if err == nil {
				times = store
			} else {
				fmt.Fprintf(os.Stderr, "[elysian] 防火墙时间账本打开失败，退回会话账本：%v\n", err)
			}
		} else {
			fmt.Fprintf(os.Stderr, "[elysian] 防火墙时间账本打开失败，退回会话账本：%v\n", err)
		}
	}
	return &execHostDeps{fwPaths: defaultFirewallPaths, times: times, now: now}
}

func (h *execHostDeps) RunUfw(args []string) (string, error) {
	return execToStdout("ufw", args)
}

func (h *execHostDeps) RunSs() (string, error) {
	return execToStdout("ss", []string{"-Hultn"})
}

func (h *execHostDeps) RunIptables(args []string) (string, error) {
	return execToStdout("iptables", args)
}

func (h *execHostDeps) RunIp6tables(args []string) (string, error) {
	return execToStdout("ip6tables", args)
}

func (h *execHostDeps) ReadText(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func (h *execHostDeps) WriteText(path, content string) error {
	return writeHostFile(path, content)
}

func (h *execHostDeps) Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (h *execHostDeps) NowIso() string {
	// 与 TS new Date().toISOString() 同形：毫秒精度 UTC，Z 结尾。
	return h.now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func (h *execHostDeps) Paths() FirewallPaths { return h.fwPaths }

func (h *execHostDeps) RuleTimes() ruleTimes { return h.times }

// assembleRealService 生产装配：接线 + 账本 + 启动恢复（fire-and-forget goroutine，
// 失败只落 stderr，不阻塞也不拖垮装配）。
func assembleRealService(dbPath string, now func() time.Time) Service {
	host := newExecHostDeps(dbPath, now)
	svc := newService(host)
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				fmt.Fprintf(os.Stderr, "[elysian] ufw 启动恢复失败：%v\n", rec)
			}
		}()
		if err := restoreIfNeeded(host); err != nil {
			fmt.Fprintf(os.Stderr, "[elysian] ufw 启动恢复失败：%v\n", err)
		}
	}()
	return svc
}
