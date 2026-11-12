package panel

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/config"
)

type resourceTestHost struct {
	*fakeHost
	available         uint64
	targets           []resourceTarget
	states            map[string]resourceState
	stopGain          uint64
	panelGain         uint64
	actions           []string
	prepareError      error
	startError        error
	inspectError      error
	stopUnknown       bool
	changeBeforeStart bool
}

func (h *resourceTestHost) ObserveResources(context.Context) (resourceObservation, error) {
	return resourceObservation{Memory: ResourceMemory{TotalBytes: 2 << 30, AvailableBytes: h.available, RequiredBytes: requiredBuildMemory}, DiskAvailable: 10 << 30}, nil
}
func (h *resourceTestHost) ResourceCandidates(context.Context) ([]resourceTarget, error) {
	return h.targets, nil
}
func (h *resourceTestHost) InspectResource(_ context.Context, target resourceTarget) (resourceState, error) {
	if h.inspectError != nil {
		return resourceState{}, h.inspectError
	}
	state, ok := h.states[target.ID]
	if !ok || state.Identity != target.Identity {
		return state, errors.New("资源身份已变化")
	}
	return state, nil
}
func (h *resourceTestHost) SetResourceRunning(_ context.Context, target resourceTarget, running bool) error {
	state := h.states[target.ID]
	if running && h.changeBeforeStart {
		state.Generation = "external-start-stop"
		h.states[target.ID] = state
	}
	if running && h.startError != nil {
		return h.startError
	}
	if state.Identity != target.Identity || state.Generation != target.Generation {
		return errors.New("资源身份或运行代次已变化")
	}
	if !running && !state.Running {
		return errResourceAlreadyStopped
	}
	state.Running = running
	h.states[target.ID] = state
	if running {
		h.actions = append(h.actions, "start "+target.ID)
	} else {
		h.actions = append(h.actions, "stop "+target.ID)
		h.available += h.stopGain
		if h.stopUnknown {
			return errors.New("停止响应丢失")
		}
	}
	return nil
}
func (h *resourceTestHost) PrepareResourceRecovery(context.Context, string, string) error {
	return h.prepareError
}
func (h *resourceTestHost) Stop(ctx context.Context) error {
	h.available += h.panelGain
	return h.fakeHost.Stop(ctx)
}

func resourceFixture(t *testing.T) (Worker, taskRecord, *resourceTestHost) {
	t.Helper()
	w, r, base := setupWorker(t, "update")
	memory := uint64(1 << 30)
	target := resourceTarget{ResourceCandidate: ResourceCandidate{ID: "container:" + strings.Repeat("d", 64), Kind: "container", Name: "业务服务", MemoryBytes: &memory}, Identity: "same-container", Generation: "started-once"}
	h := &resourceTestHost{fakeHost: base, available: 512 << 20, targets: []resourceTarget{target}, states: map[string]resourceState{target.ID: {Running: true, Identity: target.Identity, Generation: target.Generation}}, stopGain: 1 << 30, panelGain: 1 << 30}
	w.Host = h
	r.TargetCommit = strings.Repeat("b", 40)
	r.Worker = filepath.Join(w.Store.tasksDir(), r.ID+".worker")
	r.ResourcePlan = &ResourcePlan{PreflightID: strings.Repeat("e", 32), Targets: []string{target.ID}, StopPanel: true}
	r.ResourceTargets = h.targets
	if err := w.Store.save(r); err != nil {
		t.Fatal(err)
	}
	return w, r, h
}
func TestResourceMemoryRequiresAvailableAndNeverCountsSwap(t *testing.T) {
	m, err := parseResourceMemory("MemTotal: 2097152 kB\nMemAvailable: 524288 kB\nSwapTotal: 4194304 kB\nSwapFree: 4194304 kB\n")
	if err != nil || m.AvailableBytes != 512<<20 || m.RequiredBytes != requiredBuildMemory {
		t.Fatalf("错误内存口径：%+v %v", m, err)
	}
	for _, raw := range []string{"MemTotal: 1 kB\nMemFree: 1 kB\n", "MemTotal: 1 kB\nMemAvailable: 2 kB\n", "MemTotal: 0 kB\nMemAvailable: 0 kB\n"} {
		if _, e := parseResourceMemory(raw); e == nil {
			t.Fatalf("无效读数被接受：%s", raw)
		}
	}
}
func TestResourcePreflightExpiresAndBindsTargetAndExactPlan(t *testing.T) {
	w, r, h := resourceFixture(t)
	_ = os.Remove(w.Store.taskPath(r.ID))
	m := Manager{Store: w.Store, Host: h, Enabled: true, Ports: r.OldPorts, Executable: filepath.Join(w.install(), "releases", "old", "elysian")}
	input := submitInput{Source: SourceGitHub, Channel: ChannelRelease, ReleaseTag: "v1.2.0", TargetCommit: r.TargetCommit}
	u := Update{Repository: Repository, Source: SourceGitHub, Channel: ChannelRelease, ReleaseTag: "v1.2.0", Available: true, TargetCommit: r.TargetCommit}
	if err := config.AtomicJSON(w.Store.updateCheckPath(input.Channel, input.Source), u); err != nil {
		t.Fatal(err)
	}
	preview, err := m.PreflightUpdate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if preview.NeedsRelease || preview.StopPanelRecommended || len(preview.Candidates) != 0 || preview.Memory.RequiredBytes != requiredUpdateMemory || preview.BlockedReason != "" {
		t.Fatalf("预编译更新不应沿用构建停机门槛：%+v", preview)
	}
	input.RequestID = "resource-request-one"
	input.ResourcePlan = &ResourcePlan{PreflightID: preview.ID, Targets: []string{}, StopPanel: false}
	one, err := m.Submit(context.Background(), "update", input, "")
	if err != nil {
		t.Fatal(err)
	}
	var p resourcePreflightRecord
	b, _ := os.ReadFile(w.Store.resourcePreflightPath(preview.ID))
	if err = json.Unmarshal(b, &p); err != nil {
		t.Fatal(err)
	}
	p.ExpiresAt = time.Now().Add(-time.Second)
	_ = config.AtomicJSON(w.Store.resourcePreflightPath(preview.ID), p)
	two, err := m.Submit(context.Background(), "update", input, "")
	if err != nil || two.ID != one.ID {
		t.Fatalf("精确重试未绕过过期预检：%+v %v", two, err)
	}
	input.ResourcePlan.StopPanel = true
	if _, err = m.Submit(context.Background(), "update", input, ""); err == nil {
		t.Fatal("同编号换停止清单应拒绝")
	}
	input.RequestID = "another-resource-request"
	if _, err = m.resourceTargets(input); err == nil {
		t.Fatal("过期预检被接受")
	}
}
func TestBuildResourcePreparationStopsOnlyConfirmedUntilEnough(t *testing.T) {
	w, r, h := resourceFixture(t)
	if err := w.prepareBuildResources(context.Background(), &r); err != nil {
		t.Fatal(err)
	}
	if len(h.actions) != 1 || h.stops != 0 || !r.ResourceStops[0].Stopped {
		t.Fatalf("达到门槛后仍扩大停机：%v %+v", h.actions, r)
	}
	if err := w.restoreResources(context.Background(), &r, true); err != nil {
		t.Fatal(err)
	}
	if len(h.actions) != 2 || r.resourcesPending() {
		t.Fatalf("未恢复：%v %+v", h.actions, r)
	}
}
func TestLowMemoryWithoutConfirmedPlanNeverStopsBusiness(t *testing.T) {
	w, r, h := resourceFixture(t)
	r.ResourcePlan = nil
	r.ResourceTargets = nil
	if err := w.checkBuildResources(context.Background(), &r); err == nil {
		t.Fatal("低内存旧请求应明确拒绝")
	}
	if len(h.actions) != 0 || h.stops != 0 {
		t.Fatal("未确认请求停止业务")
	}
}
func TestEarlyPanelStopBuildFailureRestoresPanel(t *testing.T) {
	w, r, h := resourceFixture(t)
	r.ResourceTargets = nil
	r.ResourcePlan.Targets = []string{}
	h.failBuild = true
	if err := w.Store.save(r); err != nil {
		t.Fatal(err)
	}
	if err := w.Run(context.Background(), r.ID); err == nil {
		t.Fatal("构建应失败")
	}
	got, _ := w.Store.read(r.ID)
	if h.stops != 1 || h.starts != 1 || got.resourcesPending() || got.State != "failed" {
		t.Fatalf("提前停机未恢复：%+v stops=%d starts=%d", got, h.stops, h.starts)
	}
}
func TestRollbackFailureRestartsPreviouslyVerifiedPanel(t *testing.T) {
	w, r, h := resourceFixture(t)
	// The candidate was healthy, but a later firewall verification failed. Its
	// rollback stops it again before discovering that the old release disappeared.
	r.Activated = true
	r.PanelStopIntent = true
	r.PanelRestored = true
	r.PreviousBinary = filepath.Join(w.install(), "releases", "missing", "elysian")
	if err := w.finishFailure(&r, errors.New("防火墙验证失败")); err == nil {
		t.Fatal("原始维护失败应保留")
	}
	got, err := w.Store.read(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "recovery-failed" || h.stops != 1 || h.starts != 1 || !got.PanelRestored {
		t.Fatalf("回滚中途失败后未重新拉起已验证面板：%+v stops=%d starts=%d", got, h.stops, h.starts)
	}
}
func TestResourceRecoveryKeepsUnknownAndChangedIdentitiesBlocked(t *testing.T) {
	for _, scenario := range []string{"unknown-stop", "identity-changed", "generation-changed"} {
		t.Run(scenario, func(t *testing.T) {
			w, r, h := resourceFixture(t)
			target := h.targets[0]
			r.ResourceStops = []resourceStop{{Target: target, Stopped: scenario != "unknown-stop", Generation: target.Generation}}
			state := h.states[target.ID]
			state.Running = false
			if scenario == "identity-changed" {
				state.Identity = "replacement"
			}
			if scenario == "generation-changed" {
				state.Generation = "restarted"
			}
			h.states[target.ID] = state
			if err := w.restoreResources(context.Background(), &r, true); err == nil || !r.resourcesPending() || len(h.actions) != 0 {
				t.Fatalf("未知事实被擅自恢复：%+v %v", r, err)
			}
		})
	}
}
func TestCommittedResourceRecoveryDoesNotRollbackVersion(t *testing.T) {
	w, r, h := resourceFixture(t)
	target := h.targets[0]
	r.Committed = true
	r.Activated = true
	r.State = "running"
	r.ResourceStops = []resourceStop{{Target: target, Stopped: true, Generation: target.Generation}}
	state := h.states[target.ID]
	state.Running = false
	h.states[target.ID] = state
	h.startError = errors.New("启动失败")
	_ = w.Store.save(r)
	if err := w.Finalize(context.Background(), r.ID); err == nil {
		t.Fatal("恢复失败应保留错误")
	}
	got, _ := w.Store.read(r.ID)
	if got.State != "recovery-failed" || !got.Committed || h.stops != 0 {
		t.Fatalf("业务恢复失败错误回滚版本：%+v", got)
	}
	h.startError = nil
	if err := w.Finalize(context.Background(), r.ID); err != nil {
		t.Fatal(err)
	}
	got, _ = w.Store.read(r.ID)
	if got.State != "succeeded" || got.resourcesPending() {
		t.Fatalf("未补完恢复：%+v", got)
	}
}
func TestFinalizerRecoversEarlyStopWithoutProbingOwnUnit(t *testing.T) {
	w, r, h := resourceFixture(t)
	r.State = "running"
	r.PanelStopIntent = true
	r.ResourceStops = []resourceStop{{Target: h.targets[0], Stopped: true, Generation: h.targets[0].Generation}}
	state := h.states[h.targets[0].ID]
	state.Running = false
	h.states[h.targets[0].ID] = state
	_ = w.Store.save(r)
	_ = w.Finalize(context.Background(), r.ID)
	got, _ := w.Store.read(r.ID)
	if got.State != "failed" || got.resourcesPending() || h.starts != 1 || len(h.actions) != 1 {
		t.Fatalf("独立收尾未恢复早停：%+v", got)
	}
}
func TestProtectedResourceServices(t *testing.T) {
	for _, unit := range []string{"sshd.service", "ssh-custom.service", "docker.service", "containerd.service", "NetworkManager.service", "systemd-resolved.service", "elysian-maintenance-abc.service"} {
		if !protectedResourceService(unit, "") {
			t.Fatalf("关键服务可停止：%s", unit)
		}
	}
	if !protectedResourceService("custom-login.service", "/usr/sbin/sshd -D") {
		t.Fatal("定制SSH服务未保护")
	}
	if protectedResourceService("postgresql.service", "/usr/bin/postgres") {
		t.Fatal("普通业务误禁用")
	}
}
func TestServiceIdentityIgnoresRuntimeCommandReceipts(t *testing.T) {
	a, e := staticResourceCommands("{ path=/usr/bin/demo ; argv[]=/usr/bin/demo --serve ; ignore_errors=no ; start_time=[now] ; stop_time=[n/a] ; pid=123 ; code=(null) ; status=0/0 }")
	b, f := staticResourceCommands("{ path=/usr/bin/demo ; argv[]=/usr/bin/demo --serve ; ignore_errors=no ; start_time=[then] ; stop_time=[later] ; pid=0 ; code=exited ; status=0/0 }")
	if e != nil || f != nil || resourceDigest(a) != resourceDigest(b) {
		t.Fatalf("停机回执改变了服务定义身份：%v %v", e, f)
	}
	if _, e = staticResourceCommands("unknown"); e == nil {
		t.Fatal("未知命令结构应拒绝")
	}
}
func TestStoppedServiceGenerationDetectsInterveningStartStop(t *testing.T) {
	boot := "12345678-1234-1234-1234-123456789abc"
	a, err := resourceServiceGeneration(map[string]string{"ActiveState": "inactive", "InvocationID": "", "InactiveEnterTimestampMonotonic": "100"}, boot)
	if err != nil {
		t.Fatal(err)
	}
	b, err := resourceServiceGeneration(map[string]string{"ActiveState": "inactive", "InvocationID": "", "InactiveEnterTimestampMonotonic": "200"}, boot)
	if err != nil || a == b {
		t.Fatalf("InvocationID清空后误认代次：%s %s %v", a, b, err)
	}
	if _, err = resourceServiceGeneration(map[string]string{"ActiveState": "inactive", "InactiveEnterTimestampMonotonic": "0"}, boot); err == nil {
		t.Fatal("未知停止代次被接受")
	}
}
func TestServiceRecoveryKeepsRebootAndUnrecordedHistoryBlocked(t *testing.T) {
	previousBoot := "12345678-1234-1234-1234-123456789abc"
	currentBoot := "12345678-1234-1234-1234-123456789def"
	unrecorded := func() map[string]string {
		p := map[string]string{"ActiveState": "inactive", "SubState": "dead", "Result": "success", "InvocationID": ""}
		for _, key := range resourceServiceZeroFields {
			p[key] = "0"
		}
		return p
	}
	current, err := resourceServiceGeneration(unrecorded(), currentBoot)
	if err != nil {
		t.Fatal(err)
	}
	stopped := previousBoot + ":inactive:100"
	target := resourceTarget{ResourceCandidate: ResourceCandidate{ID: "service:demo.service", Kind: "service", Name: "demo.service"}, Identity: "same-service", Generation: previousBoot + ":active:" + strings.Repeat("a", 32)}
	if resourceRestoreGenerationAllowed(target, stopped, current) || resourceRestoreGenerationAllowed(target, current, current) || resourceRestoreGenerationAllowed(target, stopped, currentBoot+":inactive:200") || !resourceRestoreGenerationAllowed(target, stopped, stopped) {
		t.Fatal("跨重启或清空历史被误认为可自动恢复")
	}
	for _, key := range append(append([]string{}, resourceServiceZeroFields...), "InvocationID", "Result", "ActiveState") {
		p := unrecorded()
		p[key] = "1"
		generation, err := resourceServiceGeneration(p, currentBoot)
		if err == nil && resourceRestoreGenerationAllowed(target, stopped, generation) {
			t.Fatalf("存在本boot痕迹仍允许恢复：%s", key)
		}
	}
	p := unrecorded()
	delete(p, "ExecMainExitTimestampMonotonic")
	if _, err := resourceServiceGeneration(p, currentBoot); err == nil {
		t.Fatal("缺失运行历史被当作零")
	}
	for _, scenario := range []struct {
		name, generation                                     string
		running, changedIdentity, race, wantError, wantStart bool
	}{
		{name: "same-boot-confirmed", generation: stopped, wantStart: true},
		{name: "same-boot-history-cleared", generation: previousBoot + ":inactive:unknown", wantError: true},
		{name: "reboot-inactive-unrecorded", generation: current, wantError: true},
		{name: "reboot-inactive-recorded", generation: currentBoot + ":inactive:200", wantError: true},
		{name: "reboot-already-running", generation: currentBoot + ":active:" + strings.Repeat("b", 32), running: true},
		{name: "reboot-running-replacement", generation: currentBoot + ":active:" + strings.Repeat("b", 32), running: true, changedIdentity: true, wantError: true},
		{name: "same-boot-start-stop-race", generation: stopped, race: true, wantError: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			w, r, h := resourceFixture(t)
			r.Committed = true
			r.State = "running"
			r.ResourceStops = []resourceStop{{Target: target, Stopped: true, Generation: stopped}}
			identity := target.Identity
			if scenario.changedIdentity {
				identity = "replacement"
			}
			h.states = map[string]resourceState{target.ID: {Running: scenario.running, Identity: identity, Generation: scenario.generation}}
			h.changeBeforeStart = scenario.race
			if err := w.Store.save(r); err != nil {
				t.Fatal(err)
			}
			err := w.Finalize(context.Background(), r.ID)
			got, readErr := w.Store.read(r.ID)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if scenario.wantError {
				if err == nil || got.State != "recovery-failed" || !got.resourcesPending() || len(h.actions) != 0 {
					t.Fatalf("未知服务被擅自启动：%+v %v", got, err)
				}
			} else {
				wantActions := 0
				if scenario.wantStart {
					wantActions = 1
				}
				if err != nil || got.State != "succeeded" || got.resourcesPending() || len(h.actions) != wantActions {
					t.Fatalf("确定服务状态未确认：%+v %v", got, err)
				}
			}
		})
	}
}

func TestResourcePreflightHTTPOnlyCreatesPreview(t *testing.T) {
	w, r, h := resourceFixture(t)
	_ = os.Remove(w.Store.taskPath(r.ID))
	m := Manager{Store: w.Store, Host: h, Enabled: true, Ports: r.OldPorts}
	input := submitInput{Source: SourceGitHub, Channel: ChannelRelease, ReleaseTag: "v1.2.0", TargetCommit: r.TargetCommit}
	_ = config.AtomicJSON(w.Store.updateCheckPath(input.Channel, input.Source), Update{Repository: Repository, Source: input.Source, Channel: input.Channel, ReleaseTag: input.ReleaseTag, TargetCommit: input.TargetCommit, Available: true})
	body, _ := json.Marshal(input)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "http://127.0.0.1:48101/update/preflight", strings.NewReader(string(body)))
	request.Header.Set("Origin", "http://127.0.0.1:48101")
	request.Header.Set("Content-Type", "application/json")
	m.Router().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("预检HTTP失败：%d %s", recorder.Code, recorder.Body.String())
	}
	rows, err := w.Store.records()
	if err != nil || len(rows) != 0 || h.dispatched != 0 || h.stops != 0 || len(h.actions) > 0 {
		t.Fatalf("预检改变了业务或创建任务：%v %v", rows, err)
	}
}
func TestReadActiveAgentRunsNeverMigrates(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "data", "harness.sqlite")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE runs(state TEXT,document TEXT); INSERT INTO runs VALUES ('running','{"sessionId":"a"}'),('waiting-input','{"sessionId":"a"}'),('succeeded','{"sessionId":"a"}'),('running','{}'); PRAGMA user_version=7`)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	count, err := readActiveAgentRuns(context.Background(), root)
	after, _ := os.ReadFile(path)
	if err != nil || count != 2 || string(before) != string(after) {
		t.Fatalf("只读计数错误或修改了库：%d %v", count, err)
	}
}
func TestResourceHelperUpgradeRetainsRecoveryAcrossRollback(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("可信root恢复程序测试只在Go开发容器执行")
	}
	root := t.TempDir()
	store := Store{Root: filepath.Join(root, "home")}
	id := strings.Repeat("a", 32)
	worker := filepath.Join(store.tasksDir(), id+".worker")
	maintenance := filepath.Join(root, "maintenance")
	if err := os.MkdirAll(filepath.Dir(worker), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(maintenance, 0755); err != nil {
		t.Fatal(err)
	}
	old := []byte("旧恢复入口")
	helper := filepath.Join(maintenance, "elysian")
	_ = os.WriteFile(helper, old, 0700)
	_ = os.WriteFile(worker, []byte("#!/bin/sh\n[ \"$1\" = maintenance-resource-version ] && printf '1\\n'\n"), 0700)
	h := SystemHost{Store: store}
	if err := h.prepareResourceRecoveryAt(context.Background(), id, worker, maintenance); err != nil {
		t.Fatal(err)
	}
	backup, _ := os.ReadFile(filepath.Join(maintenance, "elysian.before-resource-v1"))
	current, _ := os.ReadFile(helper)
	if string(backup) != string(old) || string(current) == string(old) {
		t.Fatal("稳定恢复入口未原子升级并保留备份")
	}
	_ = os.WriteFile(worker, []byte("#!/bin/sh\nprintf 'invalid\\n'\n"), 0700)
	if err := h.prepareResourceRecoveryAt(context.Background(), id, worker, maintenance); err == nil {
		t.Fatal("不支持资源恢复的helper被发布")
	}
	next, _ := os.ReadFile(helper)
	if string(next) != string(current) {
		t.Fatal("校验失败破坏原恢复入口")
	}
}
func TestDispatchRegistersIndependentResourceFinalizer(t *testing.T) {
	dir := t.TempDir()
	record := filepath.Join(dir, "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > '" + record + "'\n"
	if err := os.WriteFile(filepath.Join(dir, "systemd-run"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	h := SystemHost{Store: Store{Root: filepath.Join(dir, "home")}}
	worker := filepath.Join(dir, "task.worker")
	id := strings.Repeat("b", 32)
	if err := h.Dispatch(context.Background(), worker, id); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(record)
	out := string(b)
	if !strings.Contains(out, "--property=ExecStopPost=\""+worker+"\" maintenance-finalize "+id) || !strings.Contains(out, "--property=KillMode=control-group") || !strings.Contains(out, "--property=TimeoutStopSec=900") {
		t.Fatalf("缺少独立收尾：%s", out)
	}
}
