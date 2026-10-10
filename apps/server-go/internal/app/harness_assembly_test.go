package app

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/agent/execution"
	"elysian/server/internal/agent/harness"
	"elysian/server/internal/auth"
	"elysian/server/internal/config"
	"elysian/server/internal/panel"
	"elysian/server/internal/paths"
)

func harnessAssemblyFixture(t *testing.T) (*config.Config, harnessAssemblyOptions) {
	t.Helper()
	root := t.TempDir()
	p := paths.ElysianPaths{AgentModels: filepath.Join(root, "config", "agent-models.json"), AgentSkills: filepath.Join(root, "config", "agent-skills.json"), AgentMCPServers: filepath.Join(root, "config", "agent-mcp-servers.json"), AgentExecution: filepath.Join(root, "config", "agent-execution.json"), HarnessSqlite: filepath.Join(root, "data", "harness.sqlite"), SkillPackages: filepath.Join(root, "data", "skills"), AgentWorkspaces: filepath.Join(root, "data", "agent-workspaces")}
	return &config.Config{BareMetal: true, MountRoot: t.TempDir(), DockerSocket: filepath.Join(root, "absent.sock")}, harnessAssemblyOptions{Paths: p, Home: root}
}

func assertExtensionsClosed(t *testing.T, e *harness.Extensions) {
	t.Helper()
	if _, err := e.Skills.List(); err == nil {
		t.Error("技能存储未关闭")
	}
	if _, err := e.Config.ListProfiles(); err == nil {
		t.Error("执行配置未关闭")
	}
	if _, err := e.Workspaces.List(context.Background(), "task-fixture", 0); err == nil {
		t.Error("工作区未关闭")
	}
	if err := e.Executor.Recover(context.Background()); err == nil || !strings.Contains(err.Error(), "运行期间") {
		t.Errorf("执行器未关闭：%v", err)
	}
}

func TestHarnessAssemblyFailureClosesAllOpenedExtensions(t *testing.T) {
	cfg, options := harnessAssemblyFixture(t)
	var captured *harness.Extensions
	options.NewManager = func(deps harness.Deps) (http.Handler, func(context.Context) error, error) {
		captured = deps.Catalog.(*harness.Extensions)
		return nil, nil, errors.New("注入运行库初始化失败")
	}
	if _, closeResource, err := assembleProductionHarness(cfg, nil, options); err == nil || closeResource != nil {
		t.Fatalf("应返回装配失败：%v", err)
	}
	if captured == nil || captured.Skills == nil || captured.Config == nil || captured.Workspaces == nil || captured.Executor == nil {
		t.Fatalf("测试未打开预期资源：%+v", captured)
	}
	assertExtensionsClosed(t, captured)
}

func TestHarnessAssemblyCloseStopsManagerBeforeExtensionsAndRunsOnce(t *testing.T) {
	cfg, options := harnessAssemblyFixture(t)
	var captured *harness.Extensions
	closes := 0
	options.NewManager = func(deps harness.Deps) (http.Handler, func(context.Context) error, error) {
		captured = deps.Catalog.(*harness.Extensions)
		return http.NotFoundHandler(), func(context.Context) error {
			closes++
			if _, err := captured.Skills.List(); err != nil {
				return errors.New("Manager 停止前不能关闭其依赖")
			}
			return nil
		}, nil
	}
	_, closeResource, err := assembleProductionHarness(cfg, nil, options)
	if err != nil {
		t.Fatal(err)
	}
	if err := closeResource(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := closeResource(context.Background()); err != nil {
		t.Fatal(err)
	}
	if closes != 1 {
		t.Fatalf("Manager 关闭了 %d 次", closes)
	}
	assertExtensionsClosed(t, captured)
}

func TestHarnessUnconfiguredExecutionDoesNotFreezeBasicRuntime(t *testing.T) {
	cfg, options := harnessAssemblyFixture(t)
	recovered := false
	options.Recover = func(context.Context, *execution.Executor) error { recovered = true; return errors.New("没有 Docker") }
	options.NewManager = func(deps harness.Deps) (http.Handler, func(context.Context) error, error) {
		if deps.WorkflowRecoveryFence != panel.WorkflowRecoveryFencePath(options.Home) || !filepath.IsAbs(deps.WorkflowRecoveryFence) {
			t.Fatalf("运行内核必须接收维护冻结标记的绝对路径：%q", deps.WorkflowRecoveryFence)
		}
		if err := deps.DispatchGuard(); err != nil {
			t.Fatalf("未配置的可选能力不应冻结基础运行：%v", err)
		}
		if deps.Catalog.(*harness.Extensions).ExecutionReason == "" {
			t.Error("未提供 Docker 时应说明容器执行不可用")
		}
		return http.NotFoundHandler(), nil, nil
	}
	_, closeResource, err := assembleProductionHarness(cfg, nil, options)
	if err != nil {
		t.Fatal(err)
	}
	defer closeResource(context.Background())
	if recovered {
		t.Fatal("没有执行配置与遗留屏障时不应要求 Docker 恢复")
	}
}

func TestHarnessAssemblyReportsMalformedOptionalConfiguration(t *testing.T) {
	cfg, options := harnessAssemblyFixture(t)
	if err := os.MkdirAll(filepath.Dir(options.Paths.AgentSkills), 0700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{options.Paths.AgentSkills, options.Paths.AgentMCPServers, options.Paths.AgentExecution} {
		if err := os.WriteFile(path, []byte("损坏配置"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	options.Recover = func(context.Context, *execution.Executor) error { return nil }
	options.NewManager = func(deps harness.Deps) (http.Handler, func(context.Context) error, error) {
		e := deps.Catalog.(*harness.Extensions)
		if e.SkillsReason == "" || e.MCPReason == "" || e.ExecutionReason == "" {
			t.Fatalf("扩展错误被静默丢弃：%+v", e)
		}
		if err := deps.DispatchGuard(); err != nil {
			t.Fatalf("确认无遗留执行后，配置损坏只应禁用对应能力：%v", err)
		}
		return http.NotFoundHandler(), nil, nil
	}
	_, closeResource, err := assembleProductionHarness(cfg, nil, options)
	if err != nil {
		t.Fatal(err)
	}
	defer closeResource(context.Background())
}

func TestHarnessAssemblyRecoveryFailureFreezesDispatch(t *testing.T) {
	cfg, options := harnessAssemblyFixture(t)
	if err := os.WriteFile(cfg.DockerSocket, []byte("仅用于选择恢复分支"), 0600); err != nil {
		t.Fatal(err)
	}
	options.Recover = func(context.Context, *execution.Executor) error { return errors.New("注入停止未确认") }
	options.NewManager = func(deps harness.Deps) (http.Handler, func(context.Context) error, error) {
		if err := deps.DispatchGuard(); err == nil || !strings.Contains(err.Error(), "派发已暂停") {
			t.Fatalf("恢复失败必须冻结派发：%v", err)
		}
		if !strings.Contains(deps.Catalog.(*harness.Extensions).ExecutionReason, "恢复尚未确认") {
			t.Error("运行状态未说明恢复失败")
		}
		return http.NotFoundHandler(), nil, nil
	}
	_, closeResource, err := assembleProductionHarness(cfg, nil, options)
	if err != nil {
		t.Fatal(err)
	}
	defer closeResource(context.Background())
}

func TestHarnessAssemblyUsesConfiguredConcurrencyForBothRunKinds(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  int
	}{{"", 2}, {"1", 1}, {"4", 4}} {
		t.Run(tc.value, func(t *testing.T) {
			t.Setenv("ELYSIAN_AGENT_CONCURRENCY", tc.value)
			fixture, options := harnessAssemblyFixture(t)
			cfg := config.Load()
			cfg.BareMetal, cfg.Docker = true, false
			cfg.MountRoot, cfg.DockerSocket = fixture.MountRoot, fixture.DockerSocket
			called := false
			options.NewManager = func(deps harness.Deps) (http.Handler, func(context.Context) error, error) {
				called = true
				batch, agent := harness.DefaultLimits(), harness.DefaultAgentLimits()
				batch.Concurrency, agent.Concurrency = tc.want, tc.want
				if deps.Limits != batch || deps.AgentLimits != agent {
					t.Fatalf("配置未一致注入或改变其他限额：batch=%+v agent=%+v", deps.Limits, deps.AgentLimits)
				}
				return http.NotFoundHandler(), nil, nil
			}
			_, closeResource, err := assembleProductionHarness(cfg, nil, options)
			if err != nil {
				t.Fatal(err)
			}
			defer closeResource(context.Background())
			if !called {
				t.Fatal("生产运行内核未装配")
			}
		})
	}
}

func TestInvalidHarnessConcurrencyRejectsStartupBeforeOpeningResources(t *testing.T) {
	t.Setenv("ELYSIAN_AGENT_CONCURRENCY", "5")
	cfg := config.Load()
	cfg.BareMetal, cfg.Docker = true, false
	_, options := harnessAssemblyFixture(t)
	options.NewManager = func(harness.Deps) (http.Handler, func(context.Context) error, error) {
		t.Fatal("错误配置不能启动Worker")
		return nil, nil, nil
	}
	_, closeResource, err := assembleProductionHarness(cfg, nil, options)
	if err == nil || closeResource != nil || !strings.Contains(err.Error(), "ELYSIAN_AGENT_CONCURRENCY 必须为 1 至 4") {
		t.Fatalf("非法并发没有中文拒绝：%v", err)
	}
	if _, err := os.Stat(filepath.Dir(options.Paths.AgentModels)); !os.IsNotExist(err) {
		t.Fatalf("非法配置已打开资源：%v", err)
	}
	if runtime, err := newAssembly(cfg, nil, auth.Deps{}); err == nil || runtime != nil {
		t.Fatal("生产启动错误被静默降级为面板可用")
	}
}
