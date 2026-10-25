package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentWorkerSubcommandBypassesServerAssembly(t *testing.T) {
	input, err := os.Create(filepath.Join(t.TempDir(), "input"))
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := os.Create(filepath.Join(t.TempDir(), "output"))
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	if _, err := input.WriteString("{\"version\":1,\"generation\":\"test-generation\",\"type\":\"hello\"}\n{\"version\":1,\"generation\":\"test-generation\",\"type\":\"shutdown\"}\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := input.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	previousArgs, previousIn, previousOut := os.Args, os.Stdin, os.Stdout
	os.Args, os.Stdin, os.Stdout = []string{"elysian", "__agent-worker"}, input, output
	t.Cleanup(func() { os.Args, os.Stdin, os.Stdout = previousArgs, previousIn, previousOut })
	// 普通面板启动会拒绝该环境；Worker 在配置与凭据装配之前分发。
	t.Setenv("ELYSIAN_DOCKER", "1")
	t.Setenv("ELYSIAN_BARE_METAL", "1")
	if err := run(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(output.Name())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"type":"ready"`) || strings.Contains(string(raw), "初始密码") {
		t.Fatalf("Worker stdout 应只有协议：%s", raw)
	}
}

func TestIsElyInvocationExactMatch(t *testing.T) {
	// busybox 式 argv0 分发：basename 必须精确等于 ely，改名副本不误入 CLI 菜单。
	cases := []struct {
		argv0 string
		want  bool
	}{
		{"/usr/local/bin/ely", true},
		{"/opt/elysian/current/elysian", false},
		{"/usr/local/bin/elysian", false},
		{"/usr/local/bin/myely", false},
		{"ely-copy", false},
		{"/usr/local/bin/ely.copy", false},
		{"", false},
	}
	for _, c := range cases {
		if got := isElyInvocation(c.argv0); got != c.want {
			t.Errorf("isElyInvocation(%q) = %v，期望 %v", c.argv0, got, c.want)
		}
	}
}

func TestElyAliasDispatchesBeforeServerAssembly(t *testing.T) {
	// ely 分发位于 config.Load 之前：互斥运行模式同时设置也不影响 ely 自身语义。
	t.Setenv("ELYSIAN_DOCKER", "1")
	t.Setenv("ELYSIAN_BARE_METAL", "1")
	outFile := filepath.Join(t.TempDir(), "out")
	f, err := os.Create(outFile)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	previousArgs, previousStdout := os.Args, os.Stdout
	os.Args, os.Stdout = []string{"/usr/local/bin/ely", "--version"}, f
	t.Cleanup(func() { os.Args, os.Stdout = previousArgs, previousStdout })
	if err := run(); err != nil {
		t.Fatalf("ely --version 应成功退出：%v", err)
	}
	raw, err := os.ReadFile(outFile)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "Elysian CLI（ely）") || !strings.Contains(string(raw), "版本：") {
		t.Fatalf("ely --version 应打印 CLI 版本：%s", raw)
	}
}

func TestElyAliasUnknownArgReturnsExitCode(t *testing.T) {
	t.Setenv("ELYSIAN_DOCKER", "1")
	t.Setenv("ELYSIAN_BARE_METAL", "1")
	outFile := filepath.Join(t.TempDir(), "out")
	f, err := os.Create(outFile)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	errFile := filepath.Join(t.TempDir(), "err")
	ef, err := os.Create(errFile)
	if err != nil {
		t.Fatal(err)
	}
	defer ef.Close()
	previousArgs, previousStdout, previousStderr := os.Args, os.Stdout, os.Stderr
	os.Args, os.Stdout, os.Stderr = []string{"/usr/local/bin/ely", "resetpwd"}, f, ef
	t.Cleanup(func() { os.Args, os.Stdout, os.Stderr = previousArgs, previousStdout, previousStderr })
	err = run()
	var ec exitError
	if !errors.As(err, &ec) || ec.code != 2 {
		t.Fatalf("ely resetpwd 应以退出码 2 拒绝（不透传 elysian 子命令语义）：%v", err)
	}
	raw, err := os.ReadFile(errFile)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "用法") {
		t.Fatalf("stderr 应打印用法：%s", raw)
	}
}
