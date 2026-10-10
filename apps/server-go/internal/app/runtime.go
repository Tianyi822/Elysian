package app

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/agent/execution"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness"
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/skills"
	"elysian/server/internal/agent/harness/toolbridge"
	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/config"
	"elysian/server/internal/panel"
	"elysian/server/internal/paths"
	"elysian/server/internal/seam"
)

// Runtime 把 HTTP 入口与装配层持有的后台资源收口到一个生命周期。
type Runtime struct {
	handler    http.Handler
	closeFuncs []func(context.Context) error
	closeOnce  sync.Once
	closeDone  chan struct{}
	closeErr   error
}

func (r *Runtime) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	r.handler.ServeHTTP(w, request)
}

// Close 停止派发并回收 Worker。调用者的时限只约束等待，重复调用可继续等同一次收尾。
func (r *Runtime) Close(ctx context.Context) error {
	if ctx == nil {
		return errors.New("关闭面板运行时必须提供上下文")
	}
	r.closeOnce.Do(func() {
		go func() {
			for _, closeResource := range r.closeFuncs {
				r.closeErr = errors.Join(r.closeErr, closeResource(context.Background()))
			}
			close(r.closeDone)
		}()
	})
	select {
	case <-r.closeDone:
		return r.closeErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

// harnessFactory 供装配测试注入无真实目录、无子进程的服务。
type harnessFactory func(*config.Config, seam.DockerViews) (http.Handler, func(context.Context) error, error)

func newProductionHarness(cfg *config.Config, views seam.DockerViews) (http.Handler, func(context.Context) error, error) {
	return assembleProductionHarness(cfg, views, harnessAssemblyOptions{Paths: paths.Default, Home: paths.ElysianHome})
}

type harnessAssemblyOptions struct {
	Paths      paths.ElysianPaths
	Home       string
	NewManager func(harness.Deps) (http.Handler, func(context.Context) error, error)
	Recover    func(context.Context, *execution.Executor) error
}

func assembleProductionHarness(cfg *config.Config, views seam.DockerViews, options harnessAssemblyOptions) (_ http.Handler, _ func(context.Context) error, resultErr error) {
	if cfg.Mode() == config.ModeLocalDemo {
		return harness.UnavailableRouter("本地演示模式不启用 Agent 任务运行"), nil, nil
	}
	concurrency, err := cfg.AgentConcurrency()
	if err != nil {
		return nil, nil, err
	}
	if options.NewManager == nil {
		options.NewManager = func(deps harness.Deps) (http.Handler, func(context.Context) error, error) {
			manager, err := harness.New(deps)
			if err != nil {
				return nil, nil, err
			}
			return manager.Router(), manager.Close, nil
		}
	}
	if options.Recover == nil {
		options.Recover = func(ctx context.Context, executor *execution.Executor) error { return executor.Recover(ctx) }
	}
	resources := &Runtime{closeDone: make(chan struct{})}
	register := func(closeResource func(context.Context) error) {
		resources.closeFuncs = append([]func(context.Context) error{closeResource}, resources.closeFuncs...)
	}
	defer func() {
		if resultErr != nil {
			resultErr = errors.Join(resultErr, resources.Close(context.Background()))
		}
	}()
	bridge, err := toolbridge.New(views)
	if err != nil {
		return nil, nil, err
	}
	register(bridge.Close)
	profiles, profileErr := model.Open(options.Paths.AgentModels)
	deps := harness.Deps{Path: options.Paths.HarnessSqlite, Tools: bridge, Profiles: profiles, WorkflowRecoveryFence: panel.WorkflowRecoveryFencePath(options.Home)}
	deps.Limits = harness.DefaultLimits()
	deps.AgentLimits = harness.DefaultAgentLimits()
	deps.Limits.Concurrency = concurrency
	deps.AgentLimits.Concurrency = concurrency
	extensions := &harness.Extensions{}
	// 仅解析面板自己已知的持久目录链接；包内容与授权路径仍逐层禁止链接。
	if err = os.MkdirAll(filepath.Dir(options.Paths.AgentModels), 0700); err != nil {
		return nil, nil, err
	}
	if err = os.MkdirAll(filepath.Dir(options.Paths.HarnessSqlite), 0700); err != nil {
		return nil, nil, err
	}
	configRoot, err := filepath.EvalSymlinks(filepath.Dir(options.Paths.AgentModels))
	if err != nil {
		return nil, nil, err
	}
	dataRoot, err := filepath.EvalSymlinks(filepath.Dir(options.Paths.HarnessSqlite))
	if err != nil {
		return nil, nil, err
	}
	extensions.Skills, err = skills.Open(filepath.Join(configRoot, filepath.Base(options.Paths.AgentSkills)), filepath.Join(dataRoot, filepath.Base(options.Paths.SkillPackages)), skills.Options{})
	if err != nil {
		extensions.SkillsReason = "技能配置或包目录不可用，请检查 config/agent-skills.json 与 data/skills"
	} else {
		register(extensions.Skills.Close)
	}
	extensions.Servers, err = mcp.Open(filepath.Join(configRoot, filepath.Base(options.Paths.AgentMCPServers)))
	if err != nil {
		extensions.MCPReason = "MCP 配置不可用，请检查 config/agent-mcp-servers.json"
	}
	extensions.Config, err = execconfig.Open(filepath.Join(configRoot, filepath.Base(options.Paths.AgentExecution)), execconfig.Options{MountRoot: cfg.MountRoot})
	if err != nil {
		extensions.ExecutionReason = "容器执行配置或挂载根不可用，请检查 config/agent-execution.json 与业务挂载根"
	} else {
		register(func(context.Context) error { return extensions.Config.Close() })
	}
	extensions.Workspaces, err = workspace.Open(filepath.Join(dataRoot, filepath.Base(options.Paths.AgentWorkspaces)))
	if err != nil {
		extensions.ExecutionReason = joinDiagnostic(extensions.ExecutionReason, "任务工作区不可用，请检查 data/agent-workspaces")
	} else {
		register(func(context.Context) error { return extensions.Workspaces.Close() })
	}
	binary, binErr := os.Executable()
	if binErr == nil {
		extensions.Executor, err = execution.New(execution.Options{SocketPath: cfg.DockerSocket, SupervisorPath: binary, MountRoot: cfg.MountRoot,
			ResolveGrant: func(id string, revision int) (*execconfig.Grant, error) {
				if extensions.Config == nil {
					return nil, errors.New("容器执行授权配置不可用")
				}
				grant, err := extensions.Config.GetGrant(id, revision, true)
				if err != nil {
					return nil, err
				}
				return &grant, nil
			},
		})
		if err != nil {
			extensions.ExecutionReason = joinDiagnostic(extensions.ExecutionReason, "容器执行器初始化失败，请检查 Docker 通道配置")
		} else {
			register(extensions.Executor.Close)
		}
	} else {
		extensions.ExecutionReason = joinDiagnostic(extensions.ExecutionReason, "无法定位容器执行二进制")
	}
	needsRecovery, recoveryError := panel.AgentExecutionRecoveryRequired(options.Home)
	executionSocket := cfg.DockerSocket
	if executionSocket == "" {
		executionSocket = "/var/run/docker.sock"
	}
	if _, socketErr := os.Stat(executionSocket); socketErr == nil {
		needsRecovery = true
	}
	if extensions.Executor != nil && (needsRecovery || recoveryError != nil) {
		recoverCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		// 即使配置损坏也先确认遗留容器已回收；配置诊断只禁用相应可选能力。
		recoveryError = options.Recover(recoverCtx, extensions.Executor)
		cancel()
	} else if needsRecovery {
		recoveryError = errors.New("容器执行器未就绪，无法确认遗留容器停止")
	} else if recoveryError == nil {
		extensions.ExecutionReason = joinDiagnostic(extensions.ExecutionReason, "Docker 通道尚未提供，容器执行不可用")
	}
	if recoveryError != nil {
		extensions.ExecutionReason = joinDiagnostic(extensions.ExecutionReason, "受管执行容器恢复尚未确认，派发已暂停")
	}
	var duplex mcp.DuplexFactory
	if recoveryError == nil && extensions.Executor != nil && needsRecovery {
		duplex = extensions.Executor
	}
	extensions.MCP = mcp.NewClient(nil, duplex)
	register(extensions.MCP.Close)
	deps.Catalog = extensions
	deps.Workspaces = extensions.Workspaces
	deps.DispatchGuard = func() error {
		if recoveryError != nil {
			return &harness.Error{Status: 503, Code: "execution-recovery", Message: "受管执行容器恢复尚未确认，派发已暂停"}
		}
		if cfg.BareMetal {
			store := panel.Store{Root: options.Home}
			info, err := (panel.Manager{Store: store, Host: panel.SystemHost{Store: store, DockerSocket: cfg.DockerSocket}, Enabled: true}).Info()
			if err != nil || info.ActiveTask != nil {
				return &harness.Error{Status: 409, Code: "maintenance-active", Message: "面板正在维护，任务派发和审批恢复已冻结"}
			}
		}
		return nil
	}
	if profileErr != nil {
		deps.ModelConfigError = "模型配置文件不可用，请检查 config/agent-models.json"
	}
	handler, closeManager, err := options.NewManager(deps)
	if err != nil {
		return nil, nil, err
	}
	if closeManager != nil {
		register(closeManager)
	}
	return handler, resources.Close, nil
}

func joinDiagnostic(previous, next string) string {
	return strings.TrimPrefix(previous+"；"+next, "；")
}
