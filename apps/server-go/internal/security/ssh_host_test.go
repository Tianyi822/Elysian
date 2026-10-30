package security

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/contract"
)

type sshTestPortOpener struct {
	fail  bool
	calls int
	fs    *memFS
}

func (p *sshTestPortOpener) EnsurePortRule(_ context.Context, port int, _ string) contract.FirewallPortSync {
	p.calls++
	text, _ := p.fs.file("/etc/ssh/sshd_config")
	if strings.Contains(text, "2202") {
		panic("放行前已切换端口")
	}
	state := "opened"
	detail := "拒绝规则"
	if p.fail {
		state = "failed"
	}
	return contract.FirewallPortSync{State: state, Port: port, Detail: &detail}
}
func TestSSHPortPreflightKeepsOriginalOnFirewallFailure(t *testing.T) {
	for _, fail := range []bool{true, false} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			s, _, fs := newTestSshService()
			fs.writeFile(s.paths.sshdConfig, defaultConfig())
			p := &sshTestPortOpener{fail: fail, fs: fs}
			s.deps.ports = p
			settings, err := s.SetPort(2202)
			text, _ := fs.file(s.paths.sshdConfig)
			if fail {
				if err == nil || text != defaultConfig() {
					t.Fatalf("防火墙失败仍改端口：%s %v", text, err)
				}
			} else if err != nil || settings.FirewallPort == nil || settings.Port != 2202 {
				t.Fatalf("联动结果丢失：%+v %v", settings, err)
			}
		})
	}
}
func TestSSHStopTimeoutCannotReportSuccess(t *testing.T) {
	s, f, _ := newTestSshService()
	f.writeRunningPid()
	s.deps.stopSshd = func() error { return nil }
	s.deps.delay = func(int) {}
	if _, err := s.SetServiceEnabled(false); err == nil {
		t.Fatal("停止超时必须失败")
	}
}
func TestSSHPasswordDisableClosesKeyboardInteractive(t *testing.T) {
	s, _, fs := newTestSshService()
	fs.writeFile(s.paths.sshdConfig, "PasswordAuthentication no\nKbdInteractiveAuthentication yes\n")
	settings, err := s.Settings()
	if err != nil || !settings.PasswordAuthEnabled {
		t.Fatal("交互密码入口未呈现")
	}
	if _, err = s.SetAuthMethods(false, true); err != nil {
		t.Fatal(err)
	}
	text, _ := fs.file(s.paths.sshdConfig)
	if !strings.Contains(text, "KbdInteractiveAuthentication no") {
		t.Fatal(text)
	}
	if _, err = s.SetAuthMethods(true, true); err != nil {
		t.Fatal(err)
	}
	text, _ = fs.file(s.paths.sshdConfig)
	if !strings.Contains(text, "KbdInteractiveAuthentication no") {
		t.Fatal("重新开启不应擅开交互认证")
	}
}
func TestSSHPatchConflicts(t *testing.T) {
	for _, text := range []string{"Match User root\n PasswordAuthentication yes\n", "AuthenticationMethods publickey,password\n"} {
		if err := validateSshPatchScope(text, []sshdPatchEntry{{Name: "PasswordAuthentication", Value: "no"}}); err == nil {
			t.Fatal("未拒绝冲突", text)
		}
	}
}
func TestSSHCustomAuthorizedKeysRejected(t *testing.T) {
	s, _, fs := newTestSshService()
	fs.writeFile(s.paths.sshdConfig, defaultConfig())
	s.deps.effectiveConfig = func(string) (string, error) { return "authorizedkeysfile /etc/ssh/keys/%u\n", nil }
	if err := s.checkAuthorizedKeys(PasswdEntry{Name: "root", Home: "/root"}); err == nil {
		t.Fatal("不得写入未生效的默认授权文件")
	}
}
func TestSSHHistoryCountsBeyondListLimit(t *testing.T) {
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	b := newHistoryBuilder(now, map[string]string{})
	for i := 0; i < 2600; i++ {
		at := formatIsoMillis(now.Add(-time.Hour))
		b.add(ParsedLoginLine{IP: "::1", User: "root", Port: 51234, Result: "succeeded"}, fmt.Sprint(i), at)
	}
	result := b.finish(nil)
	if len(result.Records) != 2000 || result.Stats.Last7Days.Succeeded != 2600 {
		t.Fatalf("统计被列表截断：%d %+v", len(result.Records), result.Stats)
	}
}
func TestSSHModernLogFormats(t *testing.T) {
	text := "2026-10-30T10:02:03+08:00 host sshd-session[12]: Accepted keyboard-interactive/pam for root from 2001:db8::1 port 1234 ssh2\nOct 30 10:02:04 host sshd-session[13]: Failed publickey for invalid user bad from 192.0.2.1 port 4321 ssh2"
	rows := ParseSshLog(text, "2026-10-30T10:00:00Z")
	if len(rows) != 2 || rows[0].At == nil || *rows[0].At != "2026-10-30T02:02:03.000Z" || rows[0].Result != "succeeded" || rows[1].Result != "failed" {
		t.Fatalf("解析：%+v", rows)
	}
}
func TestSSHHistoryUnavailableAndDST(t *testing.T) {
	zone, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	old := time.Local
	time.Local = zone
	defer func() { time.Local = old }()
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, zone)
	b := newHistoryBuilder(now, map[string]string{})
	if b.start.Hour() != 0 || b.start.Day() != 27 {
		t.Fatal("自然日窗口错误", b.start)
	}
	result := b.finish(errors.New("权限不足"))
	if result.Info.Status != "unavailable" || result.Info.Warning == nil {
		t.Fatal(result.Info)
	}
}

// systemctl 的真实状态机替身，覆盖磁盘保存后重新创建控制器的恢复。
func newSystemdSSHTest(t *testing.T, socket bool) (*systemdSSH, map[string]sshUnit, *memFS, *[]string) {
	t.Helper()
	fs := newMemFS()
	d := &sshHostDeps{}
	fs.attach(d)
	commands := []string{}
	units := map[string]sshUnit{"ssh.service": {name: "ssh.service", active: !socket, enabled: !socket, values: map[string]string{"Id": "ssh.service", "LoadState": "loaded", "UnitFileState": "enabled", "MainPID": "0"}}}
	if socket {
		units["ssh.socket"] = sshUnit{name: "ssh.socket", active: true, enabled: true, values: map[string]string{"Id": "ssh.socket", "LoadState": "loaded", "UnitFileState": "enabled"}}
		units["ssh.service"].values["TriggeredBy"] = "ssh.socket"
	}
	h := &systemdSSH{read: d.readText, write: d.writeText, remove: d.remove, mkdir: d.mkdir, exists: d.exists, rename: d.rename, statePath: "/state/ssh.json", configText: func() (string, error) {
		return "port 2202\nlistenaddress 127.0.0.1:2202\nlistenaddress [::1]:2202\n", nil
	}}
	h.run = func(name string, args []string) (string, error) {
		commands = append(commands, name+" "+strings.Join(args, " "))
		if args[0] == "daemon-reload" {
			return "", nil
		}
		u, ok := units[args[1]]
		if args[0] == "show" {
			if !ok {
				return "LoadState=not-found\n", nil
			}
			out := ""
			for k, v := range u.values {
				if k != "ActiveState" && k != "UnitFileState" {
					out += k + "=" + v + "\n"
				}
			}
			active := "inactive"
			if u.active {
				active = "active"
			}
			enabled := "disabled"
			if u.enabled {
				enabled = "enabled"
			}
			return out + "ActiveState=" + active + "\nUnitFileState=" + enabled + "\n", nil
		}
		if !ok {
			return "", fmt.Errorf("未知单元")
		}
		switch args[0] {
		case "enable":
			u.enabled = true
		case "disable":
			u.enabled = false
		case "start", "restart":
			u.active = true
		case "stop":
			u.active = false
		}
		units[args[1]] = u
		return "", nil
	}
	return h, units, fs, &commands
}
func TestSSHSystemdPersistsActivationMode(t *testing.T) {
	for _, socket := range []bool{false, true} {
		t.Run(fmt.Sprint(socket), func(t *testing.T) {
			h, units, fs, commands := newSystemdSSHTest(t, socket)
			if err := h.setEnabled(false); err != nil {
				t.Fatal(err)
			}
			for _, u := range units {
				if u.active || u.enabled {
					t.Fatal("仍可重新激活", u)
				}
			}
			raw, _ := fs.file(h.statePath)
			if socket && !strings.Contains(raw, "socket") {
				t.Fatal(raw)
			}
			// 模拟重启后 manager 丢弃已停用单元之间的内存关联。
			if socket {
				units["ssh.service"].values["TriggeredBy"] = ""
			}

			copy := *h
			if err := copy.setEnabled(true); err != nil {
				t.Fatal(err)
			}
			name := "ssh.service"
			if socket {
				name = "ssh.socket"
			}
			if !units[name].active || !units[name].enabled {
				t.Fatal("未恢复", *commands)
			}
		})
	}
}
func TestSSHSocketApplyAndRollback(t *testing.T) {
	h, units, fs, commands := newSystemdSSHTest(t, true)
	path := "/etc/systemd/system/ssh.socket.d/90-elysian-listen.conf"
	fs.writeFile(path, "[Socket]\nListenStream=22\n")
	restore, err := h.captureState()
	if err != nil {
		t.Fatal(err)
	}
	if err = h.apply(true); err != nil {
		t.Fatal(err)
	}
	text, _ := fs.file(path)
	if !strings.Contains(text, "ListenStream=\nListenStream=127.0.0.1:2202") || !strings.Contains(text, "[::1]:2202") {
		t.Fatal(text)
	}
	if err = restore(); err != nil {
		t.Fatal(err)
	}
	text, _ = fs.file(path)
	if !strings.Contains(text, "ListenStream=22") || !units["ssh.socket"].active {
		t.Fatalf("未恢复：%s %v", text, *commands)
	}
}

func TestSSHSystemdCommandFailureRestoresOriginal(t *testing.T) {
	h, units, _, _ := newSystemdSSHTest(t, true)
	run := h.run
	failed := false
	h.run = func(name string, args []string) (string, error) {
		if !failed && args[0] == "stop" && args[1] == "ssh.service" {
			failed = true
			return "", errors.New("停止失败")
		}
		return run(name, args)
	}
	if err := h.setEnabled(false); err == nil {
		t.Fatal("失败必须报错")
	}
	if !units["ssh.socket"].active || !units["ssh.socket"].enabled {
		t.Fatal("未恢复原 socket")
	}
}
func TestSSHSystemdRecognizesSshdAliasAndCustomCommand(t *testing.T) {
	h, units, fs, _ := newSystemdSSHTest(t, false)
	u := units["ssh.service"]
	delete(units, "ssh.service")
	u.values["Id"] = "sshd.service"
	units["sshd.service"] = u
	service, _, err := h.units()
	if err != nil || service.name != "sshd.service" {
		t.Fatal(service, err)
	}
	u = units["sshd.service"]
	u.values["MainPID"] = "999"
	units["sshd.service"] = u
	fs.writeFile("/proc/999/cmdline", "/usr/sbin/sshd\x00-D\x00-p\x002222\x00")
	if err = h.validateRuntime(); err == nil {
		t.Fatal("自定义启动参数未拒绝")
	}
}

func TestSSHRotatedFileHistoryAndReadFailure(t *testing.T) {
	root := t.TempDir()
	current := filepath.Join(root, "auth.log")
	rotated := current + ".1.gz"
	if err := os.WriteFile(current, []byte("2026-10-30T10:02:03Z host sshd[12]: Accepted publickey for root from ::1 port 1234 ssh2\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(rotated)
	if err != nil {
		t.Fatal(err)
	}
	writer := gzip.NewWriter(f)
	_, _ = writer.Write([]byte("2026-10-29T10:02:03Z host sshd[13]: Failed password for root from 192.0.2.1 port 4321 ssh2\n"))
	_ = writer.Close()
	_ = f.Close()
	now := parseIsoTime("2026-10-30T12:00:00Z")
	b := newHistoryBuilder(now, map[string]string{})
	if err = readSshLogFiles(context.Background(), b, []string{current, rotated}); err != nil {
		t.Fatal(err)
	}
	result := b.finish(nil)
	if len(result.Records) != 2 || result.Stats.Last7Days.Succeeded != 1 || result.Stats.Last7Days.Failed != 1 {
		t.Fatalf("轮转统计：%+v", result)
	}
	b = newHistoryBuilder(now, map[string]string{})
	err = readSshLogFiles(context.Background(), b, []string{current + ".missing"})
	if b.finish(err).Info.Status != "unavailable" {
		t.Fatal("缺失日志不得当成真实零值")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err = scanSshLines(ctx, strings.NewReader("ignored\n"), func(string, int) {}); err == nil {
		t.Fatal("日志读取取消未生效")
	}
}

func TestSSHKeyMetadataFailureCannotReplaceExistingKey(t *testing.T) {
	s, _, fs := newTestSshService()
	fs.writeFile(s.paths.sshdConfig, defaultConfig())
	old := "ssh-ed25519 AAAAold existing\n"
	fs.writeFile("/root/.ssh/authorized_keys", old)
	chmod := s.deps.chmod
	s.deps.chmod = func(path string, mode uint32) error {
		if strings.HasSuffix(path, "authorized_keys.elysian-tmp") {
			return errors.New("无法设置权限")
		}
		return chmod(path, mode)
	}
	if _, err := s.CreateRootKey(); err == nil {
		t.Fatal("权限失败应拒绝发布")
	}
	current, _ := fs.file("/root/.ssh/authorized_keys")
	if current != old {
		t.Fatal("旧密钥被替换", current)
	}
}

func TestSSHComplexIncludeCannotBypassMatchGuard(t *testing.T) {
	s, _, _ := newTestSshService()
	for _, pattern := range []string{"\"/etc/ssh/sshd_config.d/*.conf\"", "/etc/ssh/*/*.conf", "/etc/ssh/[ab].conf"} {
		if _, err := s.expandIncludePattern(pattern, 0); err == nil {
			t.Fatal("未拒绝无法完整解析的 Include", pattern)
		}
	}
	if _, err := s.expandIncludes("", 16); err == nil {
		t.Fatal("嵌套深度不得静默截断")
	}
}
