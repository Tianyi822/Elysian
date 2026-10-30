package security

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 仅在显式指定的独立容器中执行，绝不使用开发栈的状态卷或宿主账号。
func TestSSHIsolatedRealExecution(t *testing.T) {
	if os.Getenv("ELYSIAN_SSH_INTEGRATION") != "1" {
		t.Skip("需要独立 SSH 验收容器")
	}
	if _, err := os.Stat("/.dockerenv"); err != nil || os.Geteuid() != 0 {
		t.Fatal("真实 SSH 验收仅允许独立 root 容器")
	}
	root := t.TempDir()
	port := freeSshPort(t)
	paths := sshPaths{sshdConfig: filepath.Join(root, "sshd_config"), sshdPidFile: filepath.Join(root, "sshd.pid"), sshdLog: filepath.Join(root, "sshd.log"), keygenWorkspace: filepath.Join(root, "keys"), changedAtStamp: filepath.Join(root, "state", "changed"), passwordResetAtStamp: filepath.Join(root, "state", "password")}
	config := fmt.Sprintf("Port %d\nListenAddress 127.0.0.1\nPidFile %s\nHostKey /etc/ssh/ssh_host_ed25519_key\nPermitRootLogin yes\nPasswordAuthentication yes\nPubkeyAuthentication yes\nKbdInteractiveAuthentication no\nUsePAM no\nLogLevel VERBOSE\n", port, paths.sshdPidFile)
	if err := os.WriteFile(paths.sshdConfig, []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	deps := newRealSshDepsWithWorkspace(time.Now, &paths)
	deps.copyMetadata = copySshMetadata
	deps.effectiveConfig = func(user string) (string, error) {
		args := []string{"-T", "-f", paths.sshdConfig}
		if user != "" {
			args = append(args, "-C", "user="+user+",host=localhost,addr=127.0.0.1")
		}
		return deps.runSshd(args)
	}
	deps.verifyConfig = (&systemdSSH{run: execToStdout}).verifyListeners
	svc := newSshService(deps)
	defer deps.stopSshd()
	if _, err := svc.SetServiceEnabled(true); err != nil {
		t.Fatal(err)
	}
	result, err := svc.CreateRootKey()
	if err != nil || result.Key == nil || result.Key.PrivateKey == nil {
		t.Fatalf("生成：%v", err)
	}
	private := filepath.Join(root, "identity")
	if err = os.WriteFile(private, []byte(*result.Key.PrivateKey), 0600); err != nil {
		t.Fatal(err)
	}
	loginUser := "root"
	connect := func(key bool, password string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		args := []string{"-F", "/dev/null", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=3", "-p", strconv.Itoa(port)}
		if key {
			args = append(args, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-i", private)
		} else {
			args = append(args, "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1")
		}
		args = append(args, loginUser+"@127.0.0.1", "printf ssh-ok")
		cmd := exec.CommandContext(ctx, "ssh", args...)
		cmd.Env = append(os.Environ(), "SSH_ASKPASS="+filepath.Join(root, "askpass"), "SSH_ASKPASS_REQUIRE=force", "DISPLAY=:0", "ELYSIAN_TEST_PASSWORD="+password)
		output, e := cmd.Output()
		if e == nil && string(output) != "ssh-ok" {
			return fmt.Errorf("登录输出异常")
		}
		return e
	}
	if err = connect(true, ""); err != nil {
		t.Fatalf("真实密钥登录失败：%v", err)
	}
	userKey, e := svc.CreateKey("isolated-user", "elysian")
	if e != nil || userKey.PrivateKey == nil {
		t.Fatal("普通账号密钥创建失败", e)
	}
	loginUser = "elysian"
	if e = os.WriteFile(private, []byte(*userKey.PrivateKey), 0600); e != nil {
		t.Fatal(e)
	}
	if e = connect(true, ""); e != nil {
		t.Fatal("普通账号真实密钥登录失败", e)
	}
	if e = svc.RemoveKey(userKey.ID); e != nil {
		t.Fatal(e)
	}
	if e = connect(true, ""); e == nil {
		t.Fatal("删除密钥后仍能登录")
	}
	loginUser = "root"
	if e = os.WriteFile(private, []byte(*result.Key.PrivateKey), 0600); e != nil {
		t.Fatal(e)
	}
	if err = os.WriteFile(filepath.Join(root, "askpass"), []byte("#!/bin/sh\nprintf '%s\\n' \"$ELYSIAN_TEST_PASSWORD\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	password := "Container-SSH-Only-42!"
	if _, err = svc.ResetRootPassword(password); err != nil {
		t.Fatal(err)
	}
	if err = connect(false, password); err != nil {
		t.Fatalf("真实密码登录失败：%v", err)
	}
	if err = connect(false, "wrong-password"); err == nil {
		t.Fatal("错误密码被接受")
	}
	if _, err = svc.SetAuthMethods(false, true); err != nil {
		t.Fatal(err)
	}
	if err = connect(false, password); err == nil {
		t.Fatal("关闭密码登录后仍能登录")
	}
	if err = connect(true, ""); err != nil {
		t.Fatal("关闭密码影响密钥登录", err)
	}
	if _, err = svc.SaveRootLoginPolicy("no"); err != nil {
		t.Fatal(err)
	}
	if err = connect(true, ""); err == nil {
		t.Fatal("关闭 root 登录未生效")
	}
	if _, err = svc.SaveRootLoginPolicy("yes"); err != nil {
		t.Fatal(err)
	}
	// 改端口后新连接只使用新端口，读取的日志来自真实 sshd。
	port = freeSshPort(t)
	if _, err = svc.SetPort(float64(port)); err != nil {
		t.Fatal(err)
	}
	if err = connect(true, ""); err != nil {
		t.Fatal("改端口后密钥登录失败", err)
	}
	history := newHistoryBuilder(time.Now(), map[string]string{})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err = readSshLogFiles(ctx, history, []string{paths.sshdLog}); err != nil {
		t.Fatal(err)
	}
	stats := history.finish(nil).Stats
	if stats.Today.Succeeded < 4 || stats.Today.Failed < 1 {
		t.Fatalf("真实认证事实未统计：%+v", stats)
	}
	if _, err = svc.SetServiceEnabled(false); err != nil {
		t.Fatal(err)
	}
	if err = connect(true, ""); err == nil {
		t.Fatal("停服后仍可接受新连接")
	}
	content, _ := os.ReadFile(paths.sshdConfig)
	if !strings.Contains(string(content), "KbdInteractiveAuthentication no") {
		t.Fatal("认证配置丢失")
	}
}
func freeSshPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return port
}
