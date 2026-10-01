package platform

import (
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"
)

// 安装编排对等测试（dependencySetup.test.ts）：ELYSIAN_ALREADY → already 文案；已知
// 失败句原样返回；其余输出只留尾部；configure 的幂等与不碰宿主红线；busy 单飞；
// 未知步骤拒绝；路由层行为在 routes_test.go。

func hostReturning(output string, code int) *fakeHostRunner {
	return &fakeHostRunner{runFn: func(string, time.Duration) (hostCommandResult, error) {
		return hostCommandResult{Code: code, Output: output}, nil
	}}
}

func TestSetupCaddyInstall(t *testing.T) {
	already := newDependencySetup(dependencySetupOptions{host: hostReturning("ELYSIAN_ALREADY\n", 0)})
	if got := already.Run("caddy", "install"); got.OK != true || got.Message != "Caddy 已经装好" {
		t.Fatalf("已装应短路由：%+v", got)
	}

	noApt := newDependencySetup(dependencySetupOptions{host: hostReturning(setupFailureNoApt+"\n", 42)})
	if got := noApt.Run("caddy", "install"); got.OK || got.Message != setupFailureNoApt {
		t.Fatalf("已知失败句应原样返回：%+v", got)
	}

	apt := newDependencySetup(dependencySetupOptions{
		host: hostReturning("Reading package lists\nE: Unable to locate package caddy\n", 100),
	})
	failed := apt.Run("caddy", "install")
	if failed.OK {
		t.Fatalf("失败应 ok=false：%+v", failed)
	}
	if !strings.HasPrefix(failed.Message, setupFailureGeneric+"：") {
		t.Fatalf("失败句应以通用句开头：%+v", failed)
	}
	if !strings.Contains(failed.Message, "Unable to locate package caddy") {
		t.Fatalf("失败句应带输出尾部：%+v", failed)
	}
}

func TestSetupConfigureWritesTarget(t *testing.T) {
	var scripts []string
	host := &fakeHostRunner{runFn: func(script string, _ time.Duration) (hostCommandResult, error) {
		scripts = append(scripts, script)
		if strings.Contains(script, "base64 -w 0") {
			return hostCommandResult{Code: 0, Output: "ELYSIAN_EMPTY\n"}, nil
		}
		return hostCommandResult{Code: 0, Output: "ELYSIAN_DONE\n"}, nil
	}}
	setup := newDependencySetup(dependencySetupOptions{
		host:       host,
		socketPath: func() string { return "/run/caddy/admin.sock" },
	})
	if got := setup.Run("caddy", "configure"); !got.OK || got.Message != "管理端点已写入" {
		t.Fatalf("空文件应写入目标地址：%+v", got)
	}
	if len(scripts) != 2 {
		t.Fatalf("应先读后写两步：%d", len(scripts))
	}
	if !strings.Contains(scripts[0], "base64 -w 0") {
		t.Fatalf("第一步应是读脚本：%q", scripts[0])
	}
	payloadPattern := regexp.MustCompile(`printf '%s' '([A-Za-z0-9+/=]*)'`)
	matched := payloadPattern.FindStringSubmatch(scripts[1])
	if matched == nil {
		t.Fatalf("写脚本应只携带 base64：%q", scripts[1])
	}
	decoded, err := decodeBase64Lenient(matched[1])
	if err != nil {
		t.Fatalf("载荷解码失败：%v", err)
	}
	want, _ := ensureCaddyAdminSocket("", "/run/caddy/admin.sock")
	if decoded != want {
		t.Fatalf("写入内容不符：\n got %q\nwant %q", decoded, want)
	}
}

func TestSetupConfigureSkipsWhenAlreadyCorrect(t *testing.T) {
	existing, _ := ensureCaddyAdminSocket("", "/run/caddy/admin.sock")
	encoded := base64Encode(existing)
	writes := 0
	host := &fakeHostRunner{runFn: func(script string, _ time.Duration) (hostCommandResult, error) {
		if strings.Contains(script, "base64 -w 0") {
			return hostCommandResult{Code: 0, Output: "ELYSIAN_B64:" + encoded + "\n"}, nil
		}
		writes++
		return hostCommandResult{Code: 0, Output: "ELYSIAN_DONE\n"}, nil
	}}
	setup := newDependencySetup(dependencySetupOptions{
		host:       host,
		socketPath: func() string { return "/run/caddy/admin.sock" },
	})
	if got := setup.Run("caddy", "configure"); !got.OK || got.Message != "管理端点已是目标地址" {
		t.Fatalf("已正确应零写：%+v", got)
	}
	if writes != 0 {
		t.Fatalf("不应写宿主：writes=%d", writes)
	}
}

func TestSetupConfigureInvalidSocketPath(t *testing.T) {
	host := &fakeHostRunner{runFn: func(string, time.Duration) (hostCommandResult, error) {
		t.Fatal("非法路径不应碰宿主")
		return hostCommandResult{}, nil
	}}
	setup := newDependencySetup(dependencySetupOptions{
		host:       host,
		socketPath: func() string { return "/tmp/evil.sock" },
	})
	if got := setup.Run("caddy", "configure"); got.OK || got.Message != setupFailureSocketPath {
		t.Fatalf("非法路径应拒绝：%+v", got)
	}
}

func TestSetupConfigureUnclosedGlobal(t *testing.T) {
	raw := "{\n\tadmin off\n"
	host := &fakeHostRunner{runFn: func(string, time.Duration) (hostCommandResult, error) {
		return hostCommandResult{Code: 0, Output: "ELYSIAN_B64:" + base64Encode(raw) + "\n"}, nil
	}}
	setup := newDependencySetup(dependencySetupOptions{
		host:       host,
		socketPath: func() string { return "/run/caddy/admin.sock" },
	})
	if got := setup.Run("caddy", "configure"); got.OK || got.Message != caddyfileGlobalUnclosed {
		t.Fatalf("全局段残缺应拒绝：%+v", got)
	}
}

func TestSetupHostCommandErrorPassthrough(t *testing.T) {
	host := &fakeHostRunner{runFn: func(string, time.Duration) (hostCommandResult, error) {
		return hostCommandResult{}, &hostCommandError{setupFailureEngine}
	}}
	setup := newDependencySetup(dependencySetupOptions{host: host})
	if got := setup.Run("docker", "install"); got.OK || got.Message != setupFailureEngine {
		t.Fatalf("HostCommandError 应原样透传：%+v", got)
	}
}

func TestSetupUnexpectedErrorNoPathLeak(t *testing.T) {
	host := &fakeHostRunner{runFn: func(string, time.Duration) (hostCommandResult, error) {
		return hostCommandResult{}, errors.New("connect ENOENT /secret/docker.sock")
	}}
	setup := newDependencySetup(dependencySetupOptions{host: host})
	got := setup.Run("docker", "install")
	if got.OK || got.Message != setupFailureGeneric {
		t.Fatalf("意外异常应按通用失败收口：%+v", got)
	}
	if strings.Contains(got.Message, "docker.sock") {
		t.Fatalf("意外异常不得把宿主路径带回：%q", got.Message)
	}
}

func TestSetupCaddyfileInvalidSentence(t *testing.T) {
	setup := newDependencySetup(dependencySetupOptions{
		host: hostReturning(setupFailureCaddyfileInvalid+"\n", 42),
	})
	if got := setup.Run("caddy", "configure"); got.OK || got.Message != setupFailureCaddyfileInvalid {
		t.Fatalf("校验失败句应原样返回：%+v", got)
	}
}

func TestSetupBusySingleFlight(t *testing.T) {
	gate := make(chan struct{})
	host := &fakeHostRunner{runFn: func(string, time.Duration) (hostCommandResult, error) {
		<-gate
		return hostCommandResult{Code: 0, Output: "ELYSIAN_DONE\n"}, nil
	}}
	setup := newDependencySetup(dependencySetupOptions{host: host})
	firstDone := make(chan setupResult, 1)
	go func() { firstDone <- setup.Run("caddy", "install") }()
	deadline := time.Now().Add(2 * time.Second)
	for host.scriptCount() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("第一次 run 未启动")
		}
		time.Sleep(time.Millisecond)
	}
	if got := setup.Run("docker", "enable"); got.OK || got.Message != setupFailureBusy {
		t.Fatalf("占用期间应立即失败：%+v", got)
	}
	close(gate)
	if got := <-firstDone; !got.OK || got.Message != "Caddy 已安装" {
		t.Fatalf("第一步应正常完成：%+v", got)
	}
	// busy 复位后可再次执行。
	if got := setup.Run("caddy", "install"); !got.OK {
		t.Fatalf("复位后应可再次执行：%+v", got)
	}
}

func TestSetupUnknownCombinationRejected(t *testing.T) {
	var seen string
	host := &fakeHostRunner{runFn: func(script string, _ time.Duration) (hostCommandResult, error) {
		seen = script
		return hostCommandResult{Code: 0, Output: "ELYSIAN_DONE\n"}, nil
	}}
	setup := newDependencySetup(dependencySetupOptions{host: host})
	if got := setup.Run("docker", "install"); !got.OK || got.Message != "Docker 已安装" {
		t.Fatalf("docker install 应完成：%+v", got)
	}
	if seen != dockerInstallScript {
		t.Fatalf("docker install 脚本应逐字等于常量")
	}
	if got := setup.Run("docker", "configure"); got.OK || got.Message != setupFailureStep {
		t.Fatalf("docker/configure 组合应拒绝：%+v", got)
	}
	if !strings.Contains(caddyInstallScript, "apt-get install -y caddy") {
		t.Fatal("Caddy 安装脚本应含官方安装命令")
	}
}

func TestFailureMessageTailByRune(t *testing.T) {
	// 尾部 180 字符按 rune（对齐 JS 按字符截断，中文不被切碎）。
	output := strings.Repeat("中", 250) + "TAILMARK"
	message := failureMessage(output)
	want := setupFailureGeneric + "：" + strings.Repeat("中", 172) + "TAILMARK"
	if message != want {
		t.Fatalf("尾部截断不符：\n got %q\nwant %q", message, want)
	}
	if len([]rune(strings.SplitN(message, "：", 2)[1])) != 180 {
		t.Fatal("尾段应恰 180 字符")
	}
}

func TestFailureMessageStripsSentinelsAndControls(t *testing.T) {
	message := failureMessage("ELYSIAN_DONE\nsome\x00\x1bnoise\u007f  ")
	if !strings.HasSuffix(message, "some noise") || strings.Contains(message, "ELYSIAN_") {
		t.Fatalf("应剥哨兵与控制字符：%q", message)
	}
	if got := failureMessage("   \n\t "); got != setupFailureGeneric {
		t.Fatalf("空输出应收口通用句：%q", got)
	}
}
