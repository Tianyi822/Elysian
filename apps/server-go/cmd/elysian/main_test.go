package main

import (
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
