package firewall

import (
	"bytes"
	"context"
	"elysian/server/internal/config"
	"elysian/server/internal/shared"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// 真实防火墙服务层的接线（firewallHostDeps.ts 等价物）：ufw/ss/iptables/ip6tables 经
// exec 直接执行（非 shell），错误优先取 stderr 作 detail；规则时间账本打开失败不拖垮
// 端点，退回会话账本；容器重启后内核规则已失而 ufw.conf 仍记 ENABLED=yes 时，启动
// 同步恢复并核验实际入口，恢复失败交装配层终止启动。

// execHostDeps 生产接线。
type execHostDeps struct {
	fwPaths FirewallPaths
	times   ruleTimes
	now     func() time.Time
}

// execToStdout 执行命令取 stdout；失败时 detail 优先取 stderr.trim()，否则错误消息。
func execToStdout(name string, args []string) (string, error) {
	cmd, ctx, cancel := shared.SystemCommand(context.Background(), name, args...)
	defer cancel()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return "", shared.SystemCommandError(ctx, err)
		}
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

// assembleRealService 在服务启动前恢复规则，并核验实际入口。
func assembleRealService(dbPath string, now func() time.Time, network config.PanelNetwork, mode config.RuntimeMode) (Service, error) {
	host := newExecHostDeps(dbPath, now)
	svc := newServiceForMode(host, network, mode).(*service)
	if err := restoreIfNeeded(host, svc.entryPort); err != nil {
		return nil, err
	}
	return svc, nil
}
