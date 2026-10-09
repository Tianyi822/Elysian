// 面板维护能力的测试：Host 与 Source 都是替身，不跑 systemctl、不访问 GitHub。
package panel

import (
	"context"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/config"
	domainpanel "elysian/server/internal/panel"
)

// fakeHost 是 panel.Host 的替身：只记录调用，一切动作都成功。
type fakeHost struct {
	available bool
}

func (f *fakeHost) Available() bool { return f.available }

func (f *fakeHost) Preflight(context.Context, config.PanelNetwork, config.PanelNetwork) error {
	return nil
}

func (f *fakeHost) Dispatch(context.Context, string, string) error { return nil }

func (f *fakeHost) WorkerActive(context.Context, string) bool { return false }

func (f *fakeHost) Build(context.Context, string, string, string) (string, error) {
	return "", nil
}

func (f *fakeHost) Stop(context.Context) error  { return nil }
func (f *fakeHost) Start(context.Context) error { return nil }

func (f *fakeHost) Healthy(context.Context, config.PanelNetwork, string) error { return nil }

func (f *fakeHost) Rules(context.Context) ([]string, error) { return nil, nil }

func (f *fakeHost) AddRule(context.Context, string) error    { return nil }
func (f *fakeHost) DeleteRule(context.Context, string) error { return nil }

func (f *fakeHost) VerifyRules(context.Context, config.PanelNetwork) error { return nil }

// fakeSource 是 panel.Source 的替身：返回固定的上游事实并记录请求参数。
type fakeSource struct {
	update      domainpanel.Update
	commits     []domainpanel.CommitLog
	err         error
	gotChannel  domainpanel.UpdateChannel
	gotLimit    int
	downloadErr error
}

func (f *fakeSource) Check(_ context.Context, channel domainpanel.UpdateChannel) (domainpanel.Update, error) {
	f.gotChannel = channel
	if f.err != nil {
		return domainpanel.Update{}, f.err
	}
	return f.update, nil
}

func (f *fakeSource) History(_ context.Context, channel domainpanel.UpdateChannel, limit int) ([]domainpanel.CommitLog, error) {
	f.gotChannel = channel
	f.gotLimit = limit
	if f.err != nil {
		return nil, f.err
	}
	return f.commits, nil
}

func (f *fakeSource) Download(context.Context, string, string) error { return f.downloadErr }

func install(t *testing.T, deps Deps, cfg Config) (*kardia.Context, *tools.Registry) {
	t.Helper()
	root := kardia.NewContext()
	fibers, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(deps, cfg))
	if err != nil {
		t.Fatalf("装载失败：%v", err)
	}
	t.Cleanup(func() {
		for i := len(fibers) - 1; i >= 0; i-- {
			if err := fibers[i].Dispose(context.Background()); err != nil {
				t.Errorf("销毁失败：%v", err)
			}
		}
	})
	registry, err := tools.RegistryFrom(root)
	if err != nil {
		t.Fatalf("取注册表失败：%v", err)
	}
	return root, registry
}

// manager 拼一个只指向临时目录的面板管理器：任务台账落在 t.TempDir()，测试结束
// 由 testing 统一删除。
func manager(t *testing.T, host domainpanel.Host, source domainpanel.Source) domainpanel.Manager {
	t.Helper()
	return domainpanel.Manager{
		Store:      domainpanel.Store{Root: t.TempDir()},
		Host:       host,
		Source:     source,
		Ports:      config.DefaultPanelNetwork(),
		Enabled:    true,
		Executable: "/usr/local/bin/elysian",
	}
}

func TestPanelInfoReportsAvailability(t *testing.T) {
	root, registry := install(t, Deps{Manager: manager(t, &fakeHost{available: true}, &fakeSource{})}, Config{})

	value, err := registry.Execute(root, "panel_info", nil)
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	info, ok := value.(domainpanel.Info)
	if !ok {
		t.Fatalf("返回值类型不符：%T", value)
	}
	if !info.Available || info.Reason != "" {
		t.Fatalf("维护能力应可用：%v", info)
	}
	if info.Ports.FrontendPort != config.DefaultPanelNetwork().FrontendPort {
		t.Fatalf("端口应来自注入的配置：%v", info.Ports)
	}
	if info.ActiveTask != nil || info.LastTask != nil {
		t.Fatalf("空台账不应带任务：%v", info)
	}
}

func TestPanelInfoReportsUnavailableWithReason(t *testing.T) {
	manager := manager(t, &fakeHost{available: false}, &fakeSource{})
	manager.Enabled = false
	root, registry := install(t, Deps{Manager: manager}, Config{})

	value, err := registry.Execute(root, "panel_info", nil)
	if err != nil {
		t.Fatalf("不可用不是错误：%v", err)
	}
	info := value.(domainpanel.Info)
	if info.Available || strings.TrimSpace(info.Reason) == "" {
		t.Fatalf("应显式标注不可用与中文原因：%v", info)
	}
}

func TestUpdateCheckPassesChannelThrough(t *testing.T) {
	source := &fakeSource{update: domainpanel.Update{
		Channel: domainpanel.ChannelRelease, ReleaseTag: "v1.2.3",
		CurrentCommit: "aaa", TargetCommit: "bbb", Available: true,
	}}
	root, registry := install(t, Deps{Manager: manager(t, &fakeHost{}, source)}, Config{})

	value, err := registry.Execute(root, "panel_update_check", tools.Arguments{"channel": "release"})
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	update, ok := value.(domainpanel.Update)
	if !ok || update.ReleaseTag != "v1.2.3" || !update.Available {
		t.Fatalf("更新信息不符：%v", value)
	}
	if source.gotChannel != domainpanel.ChannelRelease {
		t.Fatalf("策略未透传：%v", source.gotChannel)
	}
}

func TestUpdateCheckRejectsUnknownChannel(t *testing.T) {
	source := &fakeSource{}
	root, registry := install(t, Deps{Manager: manager(t, &fakeHost{}, source)}, Config{})

	if _, err := registry.Execute(root, "panel_update_check", tools.Arguments{"channel": "tag"}); err == nil ||
		!strings.Contains(err.Error(), "不在允许范围内") {
		t.Fatalf("未知策略应被参数模式拒绝：%v", err)
	}
	if _, err := registry.Execute(root, "panel_update_check", nil); err == nil ||
		!strings.Contains(err.Error(), "缺少必填参数") {
		t.Fatalf("缺策略应被拒：%v", err)
	}
	if source.gotChannel != "" {
		t.Fatalf("被拒的调用不得触达上游：%v", source.gotChannel)
	}
}

func TestUpdateHistoryUsesConfiguredAndGivenLimit(t *testing.T) {
	source := &fakeSource{commits: []domainpanel.CommitLog{
		{SHA: "aaa", Message: "feat: 新增能力封装层", Time: time.Unix(0, 0).UTC()},
		{SHA: "bbb", Message: "fix: 修正端口校验", Time: time.Unix(0, 0).UTC()},
	}}
	root, registry := install(t, Deps{Manager: manager(t, &fakeHost{}, source)}, Config{HistoryLimit: 5})

	value, err := registry.Execute(root, "panel_update_history", tools.Arguments{"channel": "commit"})
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	if logs, ok := value.([]domainpanel.CommitLog); !ok || len(logs) != 2 {
		t.Fatalf("提交列表不符：%v", value)
	}
	if source.gotLimit != 5 {
		t.Fatalf("应使用配置的缺省条数，实际 %d", source.gotLimit)
	}

	if _, err := registry.Execute(root, "panel_update_history", tools.Arguments{"channel": "commit", "limit": 1}); err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	if source.gotLimit != 1 {
		t.Fatalf("应使用参数给出的条数，实际 %d", source.gotLimit)
	}
}

func TestUpstreamErrorPropagates(t *testing.T) {
	source := &fakeSource{err: context.DeadlineExceeded}
	root, registry := install(t, Deps{Manager: manager(t, &fakeHost{}, source)}, Config{})

	if _, err := registry.Execute(root, "panel_update_check", tools.Arguments{"channel": "commit"}); err == nil {
		t.Fatal("上游失败应穿透")
	}
}

func TestMissingHostOrSourceFailsClosed(t *testing.T) {
	cases := []struct {
		name    string
		manager domainpanel.Manager
		needle  string
	}{
		{"缺 Host", domainpanel.Manager{Source: &fakeSource{}}, "缺少 Host 实现"},
		{"缺 Source", domainpanel.Manager{Host: &fakeHost{}}, "缺少 Source 实现"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := kardia.NewContext()
			_, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(Deps{Manager: tc.manager}, Config{}))
			if err == nil || !strings.Contains(err.Error(), tc.needle) {
				t.Fatalf("期望错误含 %q，实际：%v", tc.needle, err)
			}
		})
	}
}

func TestNegativeHistoryLimitFailsClosed(t *testing.T) {
	root := kardia.NewContext()
	deps := Deps{Manager: manager(t, &fakeHost{}, &fakeSource{})}
	_, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(deps, Config{HistoryLimit: -1}))
	if err == nil || !strings.Contains(err.Error(), "更新日志条数不得为负") {
		t.Fatalf("负条数应被拒：%v", err)
	}
}
