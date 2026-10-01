package docker

import (
	"strings"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

// execSessions 对等测试（dockerExecSessions.test.ts 锚点）：合计上限、30 分钟
// 惰性回收、shellKind 按容器驻留。

// scriptedKit 会话机替身：记录 NewService / NewTotalLimitedService / NewConnEvents 调用。
type scriptedKit struct {
	servicesCreated int
	serviceSpec     seam.ShellSessionSpec
	serviceIdentity func() seam.TerminalIdentity
	serviceMax      int
	wrappersCreated int
	wrapGetActive   func() int
	wrapMax         int
	wrapInner       seam.TerminalsService
}

func (k *scriptedKit) NewService(deps seam.TerminalHostDeps, spec seam.ShellSessionSpec,
	identity func() seam.TerminalIdentity, maxSessions int) seam.TerminalsService {
	k.servicesCreated++
	k.serviceSpec = spec
	k.serviceIdentity = identity
	k.serviceMax = maxSessions
	return &countingService{active: 0}
}

func (k *scriptedKit) NewTotalLimitedService(inner seam.TerminalsService, getActive func() int, max int) seam.TerminalsService {
	k.wrappersCreated++
	k.wrapInner = inner
	k.wrapGetActive = getActive
	k.wrapMax = max
	return inner
}

func (k *scriptedKit) NewConnEvents(svc seam.TerminalsService, revocation seam.SessionConnections, sessionID string) seam.TerminalConnEvents {
	return &fakeConnEvents{}
}

type countingService struct {
	active int
}

func (s *countingService) TryOpen() (seam.TerminalSession, bool) { return &fakeSession{}, true }
func (s *countingService) ActiveCount() int                      { return s.active }

func newTestExecSessions(now func() time.Time, kit seam.TerminalKit) *execSessions {
	return newExecSessions(execSessionsConfig{
		kit: kit,
		createExecRunner: func(containerID string) execRunner {
			return &fakeExecRunner{run: func(cmd []string, tty bool, env []string) *execSession {
				return &execSession{fakeStdout: "bash=yes\n"}
			}}
		},
		identityForContainer: func(containerID string) seam.TerminalIdentity {
			return seam.TerminalIdentity{User: "root", HostLabel: containerID[:13], HomeDir: "/"}
		},
		listDir:      func(string, string) ([]string, error) { return nil, nil },
		listCommands: func(string, shellKind) ([]string, error) { return nil, nil },
		now:          now,
	})
}

func TestExecSessionsIdentityAndPrompt(t *testing.T) {
	kit := &scriptedKit{}
	sessions := newTestExecSessions(time.Now, kit)
	// 身份与提示符按容器驻留：hostLabel 取容器 id 前 13 位，提示符固定 "$ "。
	id := strings.Repeat("c", 64)
	sessions.mu.Lock()
	deps := sessions.hostDepsForLocked(id)
	sessions.mu.Unlock()
	identity := seam.TerminalIdentity{User: "root", HostLabel: hostLabelForContainer(id), HomeDir: "/"}
	if identity.HostLabel != strings.Repeat("c", 13) {
		t.Fatalf("hostLabel：%q", identity.HostLabel)
	}
	if deps.Prompt == nil || deps.Prompt(identity, "/") != "$ " {
		t.Fatalf("提示符固定 $ ")
	}
}

func TestExecSessionsSweepAfterIdle(t *testing.T) {
	kit := &scriptedKit{}
	base := time.UnixMilli(0)
	current := base
	sessions := newTestExecSessions(func() time.Time { return current }, kit)
	_ = sessions.CreateConnEvents(strings.Repeat("a", 64))
	if sessions.ManagedCount() != 1 {
		t.Fatalf("驻留 1：%d", sessions.ManagedCount())
	}
	// 29 分钟：未到阈值。
	current = base.Add(29 * time.Minute)
	if sessions.ManagedCount() != 1 {
		t.Fatalf("29 分钟不回收：%d", sessions.ManagedCount())
	}
	// 30 分钟 + 1ms：回收。
	current = base.Add(30*time.Minute + time.Millisecond)
	if sessions.ManagedCount() != 0 {
		t.Fatalf("30 分钟回收：%d", sessions.ManagedCount())
	}
}

func TestExecSessionsActiveNotSwept(t *testing.T) {
	kit := &scriptedKit{}
	base := time.UnixMilli(0)
	current := base
	sessions := newTestExecSessions(func() time.Time { return current }, kit)
	_ = sessions.CreateConnEvents(strings.Repeat("a", 64))
	// 容器有活跃会话：即便超过阈值也绝不清。
	sessions.mu.Lock()
	sessions.services[strings.Repeat("a", 64)].(*countingService).active = 1
	sessions.mu.Unlock()
	current = base.Add(2 * time.Hour)
	if sessions.ManagedCount() != 1 {
		t.Fatalf("活跃中不清扫：%d", sessions.ManagedCount())
	}
}

func TestExecSessionsLastUsedRefresh(t *testing.T) {
	kit := &scriptedKit{}
	base := time.UnixMilli(0)
	current := base
	sessions := newTestExecSessions(func() time.Time { return current }, kit)
	_ = sessions.CreateConnEvents(strings.Repeat("a", 64))
	current = base.Add(20 * time.Minute)
	_ = sessions.CreateConnEvents(strings.Repeat("a", 64))
	current = base.Add(45 * time.Minute)
	if sessions.ManagedCount() != 1 {
		t.Fatalf("最后使用时间刷新后重新计数：%d", sessions.ManagedCount())
	}
	current = base.Add(50*time.Minute + time.Millisecond)
	if sessions.ManagedCount() != 0 {
		t.Fatalf("刷新后到点回收：%d", sessions.ManagedCount())
	}
}

func TestExecSessionsShellKindPerContainer(t *testing.T) {
	kit := &scriptedKit{}
	sessions := newTestExecSessions(time.Now, kit)
	sessions.mu.Lock()
	_ = sessions.hostDepsForLocked(strings.Repeat("b", 64))
	state := sessions.stateForLocked(strings.Repeat("b", 64))
	sessions.mu.Unlock()
	if state.getShellKind() != "" {
		t.Fatalf("探测前 shellKind 为空")
	}
	state.setShellKind(shellBash)
	if state.getShellKind() != shellBash {
		t.Fatal("探测后驻留 bash")
	}
}

func TestCreateConnEvents经合计上限包装器且规格身份按容器注入(t *testing.T) {
	kit := &scriptedKit{}
	sessions := newTestExecSessions(time.Now, kit)
	id := strings.Repeat("a", 64)
	_ = sessions.CreateConnEvents(id)

	// 会话机注入：空启动行规格（驯化由 exec pty 自带）、按容器解析的身份、单容器上限 5。
	if kit.servicesCreated != 1 {
		t.Fatalf("应驻留 1 个按容器 service：%d", kit.servicesCreated)
	}
	if kit.serviceSpec.StartupLine != "" || len(kit.serviceSpec.Env) != 0 {
		t.Fatalf("容器 exec 规格应为空启动行：%+v", kit.serviceSpec)
	}
	if kit.serviceIdentity == nil {
		t.Fatal("身份解析应注入")
	}
	identity := kit.serviceIdentity()
	if identity.User != "root" || identity.HostLabel != id[:13] || identity.HomeDir != "/" {
		t.Fatalf("身份 = %+v，期望 root@%s", identity, id[:13])
	}
	if kit.serviceMax != dockerExecMaxSessions {
		t.Fatalf("单容器上限 = %d", kit.serviceMax)
	}

	// 合计上限包装器：CreateConnEvents 经 kit 包装，getActive 接全部容器活跃合计。
	if kit.wrappersCreated != 1 || kit.wrapMax != dockerExecMaxSessions {
		t.Fatalf("包装器 = %d 个、max = %d，期望 1 个、%d", kit.wrappersCreated, kit.wrapMax, dockerExecMaxSessions)
	}
	if kit.wrapGetActive == nil || kit.wrapGetActive() != 0 {
		t.Fatal("getActive 应接全部容器活跃合计")
	}
}
