// Package config 的骨架测试：钉住「严格等于 1 才开」的判定口径与运行模式双闸门。
package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStrictlyOne(t *testing.T) {
	cases := []struct {
		env  string
		want bool
	}{
		{"1", true},
		{"0", false},
		{"true", false},
		{"", false},
		{"01", false},
		{" 1", false},
	}
	for _, tc := range cases {
		if got := strictlyOne(tc.env); got != tc.want {
			t.Errorf("strictlyOne(%q) = %v，期望 %v", tc.env, got, tc.want)
		}
	}
}

func TestLoadDefaults(t *testing.T) {
	cfg := load(func(string) string { return "" }, false)
	if cfg.Docker || cfg.BareMetal || cfg.AuthDev || cfg.CookieSecure {
		t.Fatal("缺省环境下全部开关应当关闭")
	}
	if cfg.DockerSocket != "/var/run/docker.sock" {
		t.Errorf("DockerSocket 缺省应为 /var/run/docker.sock，实际 %q", cfg.DockerSocket)
	}
	if cfg.CaddySocket != "/run/caddy/admin.sock" {
		t.Errorf("CaddySocket 缺省应为 /run/caddy/admin.sock，实际 %q", cfg.CaddySocket)
	}
	if cfg.MountRoot != "/srv" {
		t.Errorf("MountRoot 缺省应为 /srv，实际 %q", cfg.MountRoot)
	}
	if cfg.ListenHost != "127.0.0.1" {
		t.Errorf("ListenHost 缺省应为 127.0.0.1，实际 %q", cfg.ListenHost)
	}
}

func TestAgentRuntimeSnapshotAndLegacyEnvironmentIgnored(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "config", "agent", "runtime.json")
	oldPath := filepath.Join(root, "config", "agent-runtime.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(oldPath, []byte(`{"version":1,"concurrency":4}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := load(func(key string) string {
		if key == "ELYSIAN_AGENT_CONCURRENCY" {
			return "4"
		}
		return ""
	}, false)
	if err := cfg.LoadAgentRuntime(path); err != nil || cfg.AgentConcurrency() != 2 {
		t.Fatalf("旧配置和环境变量不得生效：并发 %d, 错误 %v", cfg.AgentConcurrency(), err)
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"concurrency":3}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := cfg.LoadAgentRuntime(path); err != nil || cfg.AgentConcurrency() != 2 {
		t.Fatalf("已装配配置必须保持快照：并发 %d, 错误 %v", cfg.AgentConcurrency(), err)
	}
	newCfg := &Config{}
	if err := newCfg.LoadAgentRuntime(path); err != nil || newCfg.AgentConcurrency() != 3 {
		t.Fatalf("重启应读取新配置：并发 %d, 错误 %v", newCfg.AgentConcurrency(), err)
	}
}

func TestReadAgentRuntimeValidation(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		valid     bool
	}{
		{"one", `{"version":1,"concurrency":1}`, true},
		{"four", `{"version":1,"concurrency":4}`, true},
		{"zero", `{"version":1,"concurrency":0}`, false},
		{"five", `{"version":1,"concurrency":5}`, false},
		{"fraction", `{"version":1,"concurrency":1.5}`, false},
		{"missing", `{"version":1}`, false},
		{"unknown-version", `{"version":2,"concurrency":2}`, false},
		{"unknown-field", `{"version":1,"concurrency":2,"queue":32}`, false},
		{"extra-json", `{"version":1,"concurrency":2}{}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "runtime.json")
			if err := os.WriteFile(path, []byte(tc.raw), 0600); err != nil {
				t.Fatal(err)
			}
			_, err := ReadAgentRuntime(path)
			if (err == nil) != tc.valid {
				t.Fatalf("ReadAgentRuntime(%s) = %v", tc.name, err)
			}
		})
	}
}

func TestModeDoubleGate(t *testing.T) {
	cases := []struct {
		name         string
		docker       string
		bareMetal    string
		dockerEnvFil bool
		want         RuntimeMode
	}{
		{"缺省本地演示", "0", "0", false, ModeLocalDemo},
		{"env 开但无 .dockerenv", "1", "0", false, ModeLocalDemo},
		{"env 开且有 .dockerenv", "1", "0", true, ModeDocker},
		{"裸机直执", "0", "1", false, ModeBareMetal},
		{"裸机直执且有 .dockerenv", "0", "1", true, ModeBareMetal},
		{"宽松取值不算开", "true", "yes", true, ModeLocalDemo},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := map[string]string{
				"ELYSIAN_DOCKER":     tc.docker,
				"ELYSIAN_BARE_METAL": tc.bareMetal,
			}
			cfg := load(func(k string) string { return env[k] }, tc.dockerEnvFil)
			if got := cfg.Mode(); got != tc.want {
				t.Errorf("Mode() = %v，期望 %v", got, tc.want)
			}
			wantHostOps := tc.want == ModeDocker || tc.want == ModeBareMetal
			if got := cfg.HostOpsAvailable(); got != wantHostOps {
				t.Errorf("HostOpsAvailable() = %v，期望 %v", got, wantHostOps)
			}
		})
	}
}
