package docker

import (
	"context"
	"sync"
	"time"

	"elysian/server/internal/seam"
)

// 按容器驻留的终端会话表（dockerExecSessions.ts 逐字移植）：全部容器合计上限 5
//（tryOpen 包装器拒超额连接，连接层 1008）；每容器一个 terminals service；无活跃
// 会话且 30 分钟未连接的容器 service 被惰性清扫。

// dockerExecMaxSessions 容器终端合计上限。
const dockerExecMaxSessions = 5

// dockerExecServiceIdleMs 按容器驻留 service 的回收阈值（30 分钟）。
const dockerExecServiceIdleMs = 30 * 60 * 1000

// containerExecState 每容器的共享状态（shellKind 在会话 spawn 后生效）。
type containerExecState struct {
	mu        sync.Mutex
	shellKind shellKind
}

func (s *containerExecState) setShellKind(kind shellKind) {
	s.mu.Lock()
	s.shellKind = kind
	s.mu.Unlock()
}

func (s *containerExecState) getShellKind() shellKind {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.shellKind
}

// execSessionsConfig exec 会话表注入。
type execSessionsConfig struct {
	kit                  seam.TerminalKit
	createExecRunner     func(containerID string) execRunner
	identityForContainer func(containerID string) seam.TerminalIdentity
	listDir              func(containerID, path string) ([]string, error)
	listCommands         func(containerID string, kind shellKind) ([]string, error)
	now                  func() time.Time
}

// execSessions 容器 exec 终端会话表。
type execSessions struct {
	cfg        execSessionsConfig
	mu         sync.Mutex
	services   map[string]seam.TerminalsService
	states     map[string]*containerExecState
	lastUsedAt map[string]time.Time
}

func newExecSessions(cfg execSessionsConfig) *execSessions {
	if cfg.now == nil {
		cfg.now = time.Now
	}
	return &execSessions{
		cfg:        cfg,
		services:   make(map[string]seam.TerminalsService),
		states:     make(map[string]*containerExecState),
		lastUsedAt: make(map[string]time.Time),
	}
}

// sweep 惰性清扫：无活跃会话且距最后一次连接尝试超过阈值才回收，活跃中绝不清。
// （供测试直接触发；路由路径在 CreateConnEvents / ActiveCount 内联清扫。）
func (s *execSessions) sweep(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked(now)
}

// totalActive 全部容器活跃会话合计（调用方持锁）。
func (s *execSessions) totalActive() int {
	total := 0
	for _, service := range s.services {
		total += service.ActiveCount()
	}
	return total
}

// ActiveCount 当前活跃会话合计。
func (s *execSessions) ActiveCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked(s.cfg.now())
	return s.totalActive()
}

// ManagedCount 当前驻留 service 的容器数（含无活跃会话、尚未到回收阈值的）。
func (s *execSessions) ManagedCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked(s.cfg.now())
	return len(s.services)
}

func (s *execSessions) sweepLocked(now time.Time) {
	for containerID, service := range s.services {
		if service.ActiveCount() > 0 {
			continue
		}
		lastUsed, has := s.lastUsedAt[containerID]
		if !has {
			continue
		}
		if now.Sub(lastUsed) < time.Duration(dockerExecServiceIdleMs)*time.Millisecond {
			continue
		}
		delete(s.services, containerID)
		delete(s.states, containerID)
		delete(s.lastUsedAt, containerID)
	}
}

// stateFor 取（或建）容器共享状态。
func (s *execSessions) stateForLocked(containerID string) *containerExecState {
	state, ok := s.states[containerID]
	if !ok {
		state = &containerExecState{}
		s.states[containerID] = state
	}
	return state
}

// hostDepsForLocked 构造容器终端宿主依赖（身份 root@<容器 id 前 13 位>、homeDir /、
// 提示符固定 "$ "；shell 启动行由探测后的 exec pty 发送，本层不写本机启动行）。
func (s *execSessions) hostDepsForLocked(containerID string) seam.TerminalHostDeps {
	state := s.stateForLocked(containerID)
	return seam.TerminalHostDeps{
		SpawnPty: func(ctx context.Context, spec seam.ShellSessionSpec, identity seam.TerminalIdentity) (seam.PtyProcess, error) {
			return createLazyExecPty(func(ctx context.Context) (seam.PtyProcess, error) {
				exec := s.cfg.createExecRunner(containerID)
				kind := probeShell(exec)
				if ctx.Err() != nil {
					return nil, errTerminalCancelled
				}
				if kind == shellNone {
					return nil, errNoShell
				}
				state.setShellKind(kind)
				shellSpec := shellSpecFor(kind, true)
				interactive := s.cfg.createExecRunner(containerID)
				pty := createExecPty(interactive, shellSpec)
				if ctx.Err() != nil {
					_ = pty.Kill()
					return nil, errTerminalCancelled
				}
				return pty, nil
			}), nil
		},
		ListCommands: func(ctx context.Context) ([]string, error) {
			kind := state.getShellKind()
			if kind == "" || kind == shellNone {
				return nil, nil
			}
			return s.cfg.listCommands(containerID, kind)
		},
		ListDir: func(dir string) ([]string, error) {
			return s.cfg.listDir(containerID, dir)
		},
		DisposeShell: func(pid string) {
			if pid == "" {
				return
			}
			cmd, err := cleanupScriptPid(pid)
			if err != nil {
				return
			}
			session := s.cfg.createExecRunner(containerID).Run(cmd, false, nil)
			// 排空输出等脚本跑完；引擎挂起时到点放弃并断开 hijack。
			done := make(chan struct{})
			go func() {
				_, _ = readStdoutText(session)
				close(done)
			}()
			go func() {
				select {
				case <-done:
				case <-time.After(dockerExecCleanupTimeout):
				}
				session.Close()
			}()
		},
		Prompt: func(seam.TerminalIdentity, string) string { return "$ " },
	}
}

// 终端打开失败的两个固定文案。
var (
	errTerminalCancelled = &staticError{"容器终端连接已取消"}
	errNoShell           = &staticError{"该容器内没有可用的 shell"}
)

type staticError struct{ message string }

func (e *staticError) Error() string { return e.message }

// totalActiveForLimit 合计上限判据（包装器的 getActive 回调）：全部容器活跃会话合计。
// 由 terminals 域的包装器在 tryOpen 时调用，本层不持锁调用它。
func (s *execSessions) totalActiveForLimit() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.totalActive()
}

// CreateConnEvents 为容器生成一次 WS 升级的连接事件处理器。
func (s *execSessions) CreateConnEvents(containerID string) seam.TerminalConnEvents {
	now := s.cfg.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked(now)
	s.lastUsedAt[containerID] = now
	service, ok := s.services[containerID]
	if !ok {
		// 容器 exec 终端：空启动行规格（启动驯化由 exec pty 自带，不写本机启动行）
		// 与按容器解析的身份（集成期 seam 修订注入项）。
		identity := s.cfg.identityForContainer(containerID)
		service = s.cfg.kit.NewService(s.hostDepsForLocked(containerID), seam.ShellSessionSpec{},
			func() seam.TerminalIdentity { return identity }, dockerExecMaxSessions)
		s.services[containerID] = service
	}
	// 全部容器合计 5 上限：包装器由 terminals 域产出，超额 tryOpen 拒绝（连接层 1008）。
	wrapped := s.cfg.kit.NewTotalLimitedService(service, s.totalActiveForLimit, dockerExecMaxSessions)
	return s.cfg.kit.NewConnEvents(wrapped, nil, "")
}
