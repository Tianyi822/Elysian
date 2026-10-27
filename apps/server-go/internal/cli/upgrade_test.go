package cli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/cli/client"
)

type fakeMaintenance struct {
	submit           func(client.PanelUpdateInput) (client.PanelTask, error)
	lookup           func(string) (*client.PanelTask, error)
	report           func(string, int64) (client.PanelTaskReport, error)
	health           func() (string, error)
	retry            func(string) (client.PanelTask, error)
	submits, retries int
}

func (*fakeMaintenance) PanelInfo(context.Context) (client.PanelInfo, error) {
	return client.PanelInfo{Available: true}, nil
}
func (*fakeMaintenance) CheckPanelUpdate(context.Context, string, string) (client.PanelUpdate, error) {
	return client.PanelUpdate{}, nil
}
func (*fakeMaintenance) PanelCommits(context.Context, string, string) ([]client.PanelCommit, error) {
	return nil, nil
}
func (f *fakeMaintenance) SubmitPanelUpdate(_ context.Context, in client.PanelUpdateInput) (client.PanelTask, error) {
	f.submits++
	if f.submit != nil {
		return f.submit(in)
	}
	return completedUpgrade(), nil
}
func (f *fakeMaintenance) PanelTaskByRequest(_ context.Context, id string) (*client.PanelTask, error) {
	if f.lookup != nil {
		return f.lookup(id)
	}
	task := completedUpgrade()
	return &task, nil
}
func (f *fakeMaintenance) PanelTaskReport(_ context.Context, id string, offset int64) (client.PanelTaskReport, error) {
	if f.report != nil {
		return f.report(id, offset)
	}
	return client.PanelTaskReport{Task: completedUpgrade(), NextOffset: offset}, nil
}
func (f *fakeMaintenance) RetryPanelCLI(_ context.Context, id string) (client.PanelTask, error) {
	f.retries++
	if f.retry != nil {
		return f.retry(id)
	}
	return completedUpgrade(), nil
}
func (f *fakeMaintenance) PanelHealth(context.Context) (string, error) {
	if f.health != nil {
		return f.health()
	}
	return strings.Repeat("a", 40), nil
}
func completedUpgrade() client.PanelTask {
	return client.PanelTask{ID: "task-0001", Kind: "update", State: "succeeded", Phase: "finished", TargetCommit: strings.Repeat("a", 40)}
}
func upgradeFixture(t *testing.T, f *fakeMaintenance) (upgradeRuntime, upgradeState) {
	t.Helper()
	store := upgradeStore{path: filepath.Join(t.TempDir(), "upgrade.json")}
	state := upgradeState{Version: 1, BaseURL: "http://127.0.0.1:48101", PanelHome: "/panel", Input: client.PanelUpdateInput{RequestID: "request-0001", Source: "gitee", Channel: "release", ReleaseTag: "v1.2.0", TargetCommit: strings.Repeat("a", 40)}}
	if err := store.save(state); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	pauses := 0
	r := upgradeRuntime{api: f, store: store, now: func() time.Time { return now }, pause: func(ctx context.Context, d time.Duration) error {
		pauses++
		if pauses > 100 {
			return errors.New("测试检测到无限轮询")
		}
		now = now.Add(d)
		return ctx.Err()
	}}
	return r, state
}
func discardUpgrade(upgradeProgress) {}

func TestUpgradeSavedBeforeSubmitAndClearedOnlyAfterVerified(t *testing.T) {
	f := &fakeMaintenance{}
	r, state := upgradeFixture(t, f)
	f.submit = func(input client.PanelUpdateInput) (client.PanelTask, error) {
		saved, err := r.store.read(state.BaseURL, state.PanelHome)
		if err != nil || saved.Input != input {
			t.Fatalf("请求必须先落盘：%+v %v", saved, err)
		}
		return completedUpgrade(), nil
	}
	f.health = func() (string, error) {
		if _, err := os.Stat(r.store.path); err != nil {
			t.Fatal("核对运行版本前不能删除恢复指针")
		}
		return state.Input.TargetCommit, nil
	}
	code, err := r.follow(context.Background(), state, discardUpgrade, nil)
	if code != 0 || err != nil || f.submits != 1 {
		t.Fatalf("code=%d err=%v submits=%d", code, err, f.submits)
	}
	if _, err := os.Stat(r.store.path); !os.IsNotExist(err) {
		t.Fatalf("成功后应清理指针：%v", err)
	}
}

func TestUpgradeUnknownSubmissionReconcilesWithoutResubmitting(t *testing.T) {
	f := &fakeMaintenance{submit: func(client.PanelUpdateInput) (client.PanelTask, error) {
		return client.PanelTask{}, &client.Error{Kind: client.KindUnreachable}
	}}
	r, state := upgradeFixture(t, f)
	queries := 0
	f.lookup = func(id string) (*client.PanelTask, error) {
		queries++
		if id != state.Input.RequestID {
			t.Fatal(id)
		}
		if queries == 1 {
			return nil, nil
		}
		task := completedUpgrade()
		return &task, nil
	}
	code, err := r.follow(context.Background(), state, discardUpgrade, nil)
	if code != 0 || err != nil || queries != 2 || f.submits != 1 {
		t.Fatalf("%d %v lookups=%d submits=%d", code, err, queries, f.submits)
	}
}

func TestUpgradeDrainsTerminalLogPagesAndReconnects(t *testing.T) {
	f := &fakeMaintenance{}
	r, state := upgradeFixture(t, f)
	state.TaskID = "task-0001"
	offsets := []int64{}
	calls := 0
	logs := ""
	f.report = func(_ string, offset int64) (client.PanelTaskReport, error) {
		calls++
		offsets = append(offsets, offset)
		if calls == 1 {
			return client.PanelTaskReport{}, &client.Error{Kind: client.KindNotRunning}
		}
		if calls == 2 {
			return client.PanelTaskReport{Task: completedUpgrade(), Logs: "中文", NextOffset: 6, HasMore: true}, nil
		}
		return client.PanelTaskReport{Task: completedUpgrade(), Logs: "日志", NextOffset: 12}, nil
	}
	code, err := r.follow(context.Background(), state, func(p upgradeProgress) { logs += p.Logs }, nil)
	if code != 0 || err != nil || logs != "中文日志" || len(offsets) != 3 || offsets[2] != 6 || f.submits != 0 {
		t.Fatalf("%d %v logs=%s offsets=%v", code, err, logs, offsets)
	}
}

func TestUpgradeCancelRetainsPointerAndReentryDoesNotSubmit(t *testing.T) {
	f := &fakeMaintenance{}
	r, state := upgradeFixture(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	f.report = func(string, int64) (client.PanelTaskReport, error) {
		cancel()
		return client.PanelTaskReport{}, &client.Error{Kind: client.KindUnreachable}
	}
	code, _ := r.follow(ctx, state, discardUpgrade, nil)
	if code != 130 {
		t.Fatalf("code=%d", code)
	}
	saved, err := r.store.read(state.BaseURL, state.PanelHome)
	if err != nil || saved.TaskID == "" {
		t.Fatalf("退出丢失指针：%+v %v", saved, err)
	}
	f.report = nil
	code, err = r.follow(context.Background(), *saved, discardUpgrade, nil)
	if code != 0 || err != nil || f.submits != 1 {
		t.Fatalf("恢复重复提交：%d %v submits=%d", code, err, f.submits)
	}
}

func TestUpgradeVersionMismatchRetainsPointer(t *testing.T) {
	f := &fakeMaintenance{health: func() (string, error) { return strings.Repeat("b", 40), nil }}
	r, state := upgradeFixture(t, f)
	code, err := r.follow(context.Background(), state, discardUpgrade, nil)
	if code != 1 || err == nil || !strings.Contains(err.Error(), "不一致") {
		t.Fatalf("%d %v", code, err)
	}
	if saved, err := r.store.read(state.BaseURL, state.PanelHome); err != nil || saved == nil {
		t.Fatal("必须保留恢复指针")
	}
}

func TestUpgradeFailureRetention(t *testing.T) {
	for _, terminal := range []string{"failed", "rolled-back", "recovery-failed"} {
		t.Run(terminal, func(t *testing.T) {
			f := &fakeMaintenance{}
			r, state := upgradeFixture(t, f)
			f.report = func(string, int64) (client.PanelTaskReport, error) {
				task := completedUpgrade()
				task.State = terminal
				task.Error = "服务端原因"
				return client.PanelTaskReport{Task: task}, nil
			}
			code, err := r.follow(context.Background(), state, discardUpgrade, nil)
			if code != 1 || err == nil || !strings.Contains(err.Error(), "服务端原因") {
				t.Fatalf("%d %v", code, err)
			}
			_, statErr := os.Stat(r.store.path)
			if (terminal == "recovery-failed") != (statErr == nil) {
				t.Fatalf("恢复记录状态错误：%v", statErr)
			}
		})
	}
}

func TestUpgradeDefiniteRejectionDoesNotStayPending(t *testing.T) {
	f := &fakeMaintenance{submit: func(client.PanelUpdateInput) (client.PanelTask, error) {
		return client.PanelTask{}, &client.Error{Status: 409, Message: "已有维护任务"}
	}}
	r, state := upgradeFixture(t, f)
	code, err := r.follow(context.Background(), state, discardUpgrade, nil)
	if code != 1 || err == nil {
		t.Fatalf("%d %v", code, err)
	}
	if _, err := os.Stat(r.store.path); !os.IsNotExist(err) {
		t.Fatal("明确拒绝不应保留待确认请求")
	}
}

func TestUpgradeCLIRegistrationRetryAndHealthWait(t *testing.T) {
	f := &fakeMaintenance{}
	r, state := upgradeFixture(t, f)
	state.TaskID = "task-0001"
	r.retryCLI = true
	reads := 0
	healthReads := 0
	f.report = func(string, int64) (client.PanelTaskReport, error) {
		task := completedUpgrade()
		reads++
		if reads == 1 {
			setCLIRegistration(&task, "pending")
		} else if f.retries == 0 {
			setCLIRegistration(&task, "failed")
		}
		return client.PanelTaskReport{Task: task}, nil
	}
	f.health = func() (string, error) {
		healthReads++
		if healthReads == 1 {
			return "", &client.Error{Kind: client.KindNotRunning}
		}
		return state.Input.TargetCommit, nil
	}
	code, err := r.follow(context.Background(), state, discardUpgrade, nil)
	if code != 0 || err != nil || f.retries != 1 || healthReads != 2 {
		t.Fatalf("%d %v retries=%d health=%d", code, err, f.retries, healthReads)
	}
}

func setCLIRegistration(task *client.PanelTask, status string) {
	task.CLIRegistration = &client.PanelCLIRegistration{Status: status, Error: "链接被占用"}
}

func TestUpgradeStoreIdentityPermissionsAndLock(t *testing.T) {
	r, state := upgradeFixture(t, &fakeMaintenance{})
	st, err := os.Stat(r.store.path)
	if err != nil || st.Mode().Perm() != 0600 {
		t.Fatalf("mode=%v err=%v", st, err)
	}
	if _, err := r.store.read("http://127.0.0.1:9999", state.PanelHome); err == nil {
		t.Fatal("不能恢复其他面板的请求")
	}
	dir := t.TempDir()
	first, err := lockUpgrade(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if second, err := lockUpgrade(dir); err == nil {
		second.Close()
		t.Fatal("同用户更新必须互斥")
	}
}
