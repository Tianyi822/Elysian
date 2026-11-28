package docker

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// fakeHostCapacity 是可编程的宿主容量读取器；每次 Sample 调用 sample 取读数。
type fakeHostCapacity struct {
	sample func() (shared.HostMemory, error)
	calls  int
}

func (f *fakeHostCapacity) Sample(context.Context) (shared.HostMemory, error) {
	f.calls++
	return f.sample()
}

func fixedHostCapacity(memory shared.HostMemory) *fakeHostCapacity {
	return &fakeHostCapacity{sample: func() (shared.HostMemory, error) { return memory, nil }}
}

// ampleHostCapacity 报告一台内存充足的主机，供沿用既有创建流程的用例使用。
func ampleHostCapacity() seam.HostCapacity {
	return fixedHostCapacity(shared.HostMemory{TotalBytes: 64 << 30, AvailableBytes: 32 << 30})
}

// memoryTightForSmall：系统保留 256 MiB 之后只剩 511 MiB，连 small 档也放不下。
func memoryTightForSmall() shared.HostMemory {
	const mib = uint64(1) << 20
	return shared.HostMemory{TotalBytes: 2560 * mib, AvailableBytes: 256*mib + 512*mib - 1}
}

func TestHostCapacityReportJudgesEveryTier(t *testing.T) {
	const mib = uint64(1) << 20
	load, free := 0.75, uint64(4096)<<20
	facade := &AgentFacade{service: &dockerService{}, authorize: func(context.Context) error { return nil },
		hostCapacity: fixedHostCapacity(shared.HostMemory{TotalBytes: 2560 * mib, AvailableBytes: 256*mib + 1024*mib + 7*mib, Cores: 4, Load1: &load, RootFreeBytes: &free, SampledAt: "2026-11-26T11:00:00Z"})}
	report, err := facade.HostCapacity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !report.Available || report.SampledAt != "2026-11-26T11:00:00Z" || report.MemoryTotalMiB != 2560 || report.MemoryAvailableMiB != 1287 ||
		report.ReserveMiB != 256 || report.UsableMiB != 1031 || report.Cores != 4 || report.RootFreeMiB == nil || *report.RootFreeMiB != 4096 {
		t.Fatalf("容量读数汇总错误：%+v", report)
	}
	if len(report.Tiers) != 3 {
		t.Fatalf("应逐一判定三档：%+v", report.Tiers)
	}
	for i, want := range []bool{true, true, false} {
		if report.Tiers[i].Fits != want {
			t.Errorf("档位 %s 放行判定应为 %v：%+v", report.Tiers[i].Tier, want, report.Tiers[i])
		}
	}
	if first := report.Tiers[0]; first.Tier != "small" || first.MemoryMiB != 512 || first.CpuMillis != 500 {
		t.Errorf("档位换算错误：%+v", first)
	}
	if report.Note == "" {
		t.Error("容量读数应说明口径")
	}
}

func TestHostCapacityReportMarksUnavailableReadings(t *testing.T) {
	base := func(capacity seam.HostCapacity) *AgentFacade {
		return &AgentFacade{service: &dockerService{}, authorize: func(context.Context) error { return nil }, hostCapacity: capacity}
	}
	for name, facade := range map[string]*AgentFacade{
		"未装配读取器": base(nil),
		"读取失败":   base(&fakeHostCapacity{sample: func() (shared.HostMemory, error) { return shared.HostMemory{}, errors.New("boom") }}),
		"读数越界":   base(fixedHostCapacity(shared.HostMemory{TotalBytes: 100, AvailableBytes: 101})),
	} {
		report, err := facade.HostCapacity(context.Background())
		if err != nil {
			t.Fatalf("%s：%v", name, err)
		}
		if report.Available || report.Reason == "" || len(report.Tiers) != 0 {
			t.Errorf("%s：读数不可得时不得给出档位判定：%+v", name, report)
		}
	}
}

func TestHostCapacityRequiresAuthorization(t *testing.T) {
	capacity := ampleHostCapacity().(*fakeHostCapacity)
	facade := &AgentFacade{service: &dockerService{}, authorize: func(context.Context) error { return errors.New("未授权") }, hostCapacity: capacity}
	if _, err := facade.HostCapacity(context.Background()); err == nil {
		t.Fatal("未授权时不得读取容量")
	}
	if capacity.calls != 0 {
		t.Fatal("授权失败后不应采样")
	}
}

func capacityServiceInput() AgentServiceCreateInput {
	return AgentServiceCreateInput{
		Name: "web", Image: "nginx:1@sha256:" + strings.Repeat("b", 64), RequestID: strings.Repeat("1", 64),
		ResourceTier: "small", NetworkScope: "container-net",
	}
}

// capacityFacade 构造带账本、凭据登记与容量读取器的 facade；engine 脚本只应答镜像清单。
func capacityFacade(t *testing.T, capacity seam.HostCapacity, script engineScript) *AgentFacade {
	t.Helper()
	if script == nil {
		script = func(engineCall) (int, string, bool) { return 0, "", false }
	}
	service := newDockerService(serviceDeps{
		transport:       newFakeEngine(wrapScript(script)),
		mountRoot:       "/srv",
		reservedPorts:   []int{22, 48100, 48101},
		selfContainerID: strings.Repeat("f", 64),
	})
	return &AgentFacade{
		operationRoot: filepath.Join(t.TempDir(), "tasks"),
		service:       service,
		authorize:     func(context.Context) error { return nil },
		credentials:   newAgentCredentialStore(filepath.Join(t.TempDir(), "agent-service-containers.json")),
		portOpener:    &recordingPortOpener{},
		hostCapacity:  capacity,
	}
}

// wrapScript 补上镜像清单与镜像详情应答：输入摘要即镜像 ID。
func wrapScript(script engineScript) engineScript {
	imageID := strings.Repeat("b", 64)
	return func(call engineCall) (int, string, bool) {
		if status, body, ok := script(call); ok {
			return status, body, ok
		}
		switch {
		case call.Method == http.MethodGet && call.Path == "/images/json":
			return http.StatusOK, `[{"Id":"sha256:` + imageID + `"}]`, true
		case call.Method == http.MethodGet && call.Path == "/images/"+encodeEngineID("sha256:"+imageID)+"/json":
			return http.StatusOK, `{"Id":"sha256:` + imageID + `","Size":1000,"Created":"2026-11-26T00:00:00Z","RepoTags":["nginx:1"],"RepoDigests":[],"Config":{}}`, true
		case call.Method == http.MethodGet && strings.HasPrefix(call.Path, "/containers/") && strings.HasSuffix(call.Path, "/json"):
			return http.StatusNotFound, "", true
		}
		return 0, "", false
	}
}

func assertNoTaskLedger(t *testing.T, facade *AgentFacade) {
	t.Helper()
	entries, err := os.ReadDir(facade.operationRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return
		}
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("提交前拒绝不得建立任务账本：%v", entries)
	}
}

func TestSubmitServiceRejectsInsufficientCapacityBeforeDispatch(t *testing.T) {
	facade := capacityFacade(t, fixedHostCapacity(memoryTightForSmall()), nil)
	_, err := facade.SubmitService(context.Background(), capacityServiceInput())
	var rejected *AgentError
	if !errors.As(err, &rejected) || !rejected.NotDispatched {
		t.Fatalf("容量不足应是未派发的可纠正拒绝：%+v", err)
	}
	for _, want := range []string{"未创建容器", "small", "512", "可容纳的档位：无", "与用户确认"} {
		if !strings.Contains(rejected.Message, want) {
			t.Errorf("拒绝文案缺少 %q：%s", want, rejected.Message)
		}
	}
	assertNoTaskLedger(t, facade)
}

func TestSubmitServiceNamesFittingTiersWhenRejecting(t *testing.T) {
	const mib = uint64(1) << 20
	facade := capacityFacade(t, fixedHostCapacity(shared.HostMemory{TotalBytes: 2560 * mib, AvailableBytes: 256*mib + 1024*mib}), nil)
	input := capacityServiceInput()
	input.ResourceTier = "large"
	_, err := facade.SubmitService(context.Background(), input)
	var rejected *AgentError
	if !errors.As(err, &rejected) || !strings.Contains(rejected.Message, "可容纳的档位：small、medium") {
		t.Fatalf("拒绝时应列出当前可容纳的档位：%+v", err)
	}
}

func TestSubmitServiceRejectsUnreadableCapacityBeforeDispatch(t *testing.T) {
	for name, capacity := range map[string]seam.HostCapacity{
		"未装配读取器": nil,
		"读取失败":   &fakeHostCapacity{sample: func() (shared.HostMemory, error) { return shared.HostMemory{}, errors.New("boom") }},
	} {
		facade := capacityFacade(t, capacity, nil)
		_, err := facade.SubmitService(context.Background(), capacityServiceInput())
		var rejected *AgentError
		if !errors.As(err, &rejected) || !rejected.NotDispatched || !strings.Contains(rejected.Message, "未创建容器") {
			t.Errorf("%s：读数不可得时不得放行：%+v", name, err)
		}
		assertNoTaskLedger(t, facade)
	}
}

func TestSubmitServiceRejectsOccupiedAnyHostPortBeforeDispatch(t *testing.T) {
	facade := capacityFacade(t, ampleHostCapacity(), func(call engineCall) (int, string, bool) {
		if call.Method == http.MethodGet && call.Path == "/containers/json" {
			return http.StatusOK, `[{"Id":"` + strings.Repeat("e", 64) + `","Names":["/db"],"State":"running","Ports":[{"IP":"0.0.0.0","PrivatePort":3306,"PublicPort":13306,"Type":"tcp"}]}]`, true
		}
		return 0, "", false
	})
	input := capacityServiceInput()
	input.NetworkScope, input.Port, input.HostPort = "any-host", 3306, 13306
	_, err := facade.SubmitService(context.Background(), input)
	var rejected *AgentError
	if !errors.As(err, &rejected) || !rejected.NotDispatched || !strings.Contains(rejected.Message, "宿主端口已被占用：13306") {
		t.Fatalf("端口占用应是提交前的未派发拒绝：%+v", err)
	}
	assertNoTaskLedger(t, facade)
}

func TestSubmitServiceAcceptsFreeAnyHostPort(t *testing.T) {
	facade := capacityFacade(t, ampleHostCapacity(), func(call engineCall) (int, string, bool) {
		if call.Method == http.MethodGet && call.Path == "/containers/json" {
			return http.StatusOK, `[{"Id":"` + strings.Repeat("e", 64) + `","Names":["/db"],"Ports":[{"IP":"0.0.0.0","PrivatePort":3306,"PublicPort":13307,"Type":"tcp"}]}]`, true
		}
		return 0, "", false
	})
	input := capacityServiceInput()
	input.NetworkScope, input.Port, input.HostPort = "any-host", 3306, 13306
	task, err := facade.SubmitService(context.Background(), input)
	if err != nil {
		t.Fatalf("端口空闲时应受理：%v", err)
	}
	// 后台任务会继续写账本目录，等它进入终态再结束用例。
	waitContainerOperation(t, facade, task.ID)
}

func TestCreateRestrictedRejectsInsufficientCapacityBeforeCreating(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Method == http.MethodGet && call.Path == "/containers/box/json" {
			return http.StatusNotFound, "", true
		}
		return 0, "", false
	})
	facade := &AgentFacade{service: newDockerService(serviceDeps{transport: engine}), authorize: func(context.Context) error { return nil },
		hostCapacity: fixedHostCapacity(memoryTightForSmall())}
	_, err := facade.CreateRestricted(context.Background(), AgentCreateInput{Name: "box", Image: "tool:1@sha256:" + strings.Repeat("b", 64), RequestID: strings.Repeat("2", 64)})
	var rejected *AgentError
	if !errors.As(err, &rejected) || !rejected.NotDispatched || !strings.Contains(rejected.Message, "未创建容器") {
		t.Fatalf("容量不足时应未派发拒绝：%+v", err)
	}
	for _, call := range engine.Requests() {
		if call.Method != http.MethodGet {
			t.Fatalf("容量不足时不得有任何变更：%+v", call)
		}
	}
}

func waitContainerOperation(t *testing.T, facade *AgentFacade, id string) ContainerOperationTask {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		task, err := facade.InspectContainerOperation(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if task.State != "running" {
			return task
		}
		if time.Now().After(deadline) {
			t.Fatalf("容器操作未进入终态：%+v", task)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// 受理与执行之间内存被占满：执行前复核拒绝，任务落 failed（不是 unknown），且没有任何变更。
func TestServiceWorkerRechecksCapacityBeforeFirstMutation(t *testing.T) {
	readings := []shared.HostMemory{{TotalBytes: 64 << 30, AvailableBytes: 32 << 30}, memoryTightForSmall()}
	reads := 0
	capacity := &fakeHostCapacity{sample: func() (shared.HostMemory, error) {
		memory := readings[min(reads, len(readings)-1)]
		reads++
		return memory, nil
	}}
	facade := capacityFacade(t, capacity, nil)
	task, err := facade.SubmitService(context.Background(), capacityServiceInput())
	if err != nil {
		t.Fatal(err)
	}
	done := waitContainerOperation(t, facade, task.ID)
	if done.State != "failed" || done.Stage != "preflight-rejected" || done.ErrorCode != "docker-resource-insufficient" {
		t.Fatalf("执行前容量不足应落 failed + preflight-rejected：%+v", done)
	}
	for _, call := range facade.service.deps.transport.(*fakeEngine).Requests() {
		if call.Method != http.MethodGet {
			t.Fatalf("执行前拒绝不得有任何变更：%+v", call)
		}
	}
}

// serviceCreateScript 覆盖到启动为止的创建应答；start 以 500 失败。
func serviceCreateFailingStartScript(containerID string, rollbackGone bool) engineScript {
	input := capacityServiceInput()
	input.Volumes = []string{"/data"}
	digest := serviceCreateDigest(input)
	volumeName := "elysian-agent-0-" + input.RequestID
	deleted := false
	return func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == http.MethodGet && call.Path == "/containers/web/json":
			return http.StatusNotFound, "", true
		case call.Method == http.MethodPost && call.Path == "/volumes/create":
			return http.StatusCreated, `{"Name":"` + volumeName + `"}`, true
		case call.Method == http.MethodGet && call.Path == "/networks/elysian-agent-net":
			return http.StatusOK, `{"Name":"elysian-agent-net"}`, true
		case call.Method == http.MethodPost && call.Path == "/containers/create":
			return http.StatusCreated, `{"Id":"` + containerID + `"}`, true
		case call.Method == http.MethodPost && call.Path == "/containers/"+containerID+"/start":
			return http.StatusInternalServerError, `{"message":"port is already allocated"}`, true
		case call.Method == http.MethodGet && call.Path == "/containers/"+containerID+"/json":
			if deleted {
				return http.StatusNotFound, "", true
			}
			body := strings.Replace(serviceContainerInspectBody(), `"Labels":{`, `"Labels":{"elysian.agent.create-digest":"`+digest+`",`, 1)
			return http.StatusOK, body, true
		case call.Method == http.MethodDelete && call.Path == "/containers/"+containerID:
			deleted = true
			return http.StatusNoContent, "", true
		case call.Method == http.MethodGet && call.Path == "/volumes/"+volumeName:
			if rollbackGone {
				return http.StatusNotFound, "", true
			}
			return http.StatusOK, `{"Name":"` + volumeName + `","Labels":{"elysian.agent.create-digest":"` + digest + `"}}`, true
		case call.Method == http.MethodDelete && call.Path == "/volumes/"+volumeName:
			return http.StatusConflict, `{"message":"volume in use"}`, true
		}
		return 0, "", false
	}
}

func submitServiceWithVolume(t *testing.T, capacity seam.HostCapacity, script engineScript) ContainerOperationTask {
	t.Helper()
	facade := capacityFacade(t, capacity, script)
	input := capacityServiceInput()
	input.Volumes = []string{"/data"}
	task, err := facade.SubmitService(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	return waitContainerOperation(t, facade, task.ID)
}

// 启动失败并回滚、且回读确认容器与卷都已消失：任务是「无业务变更」的 failed，运行可以继续。
func TestServiceStartFailureWithVerifiedRollbackEndsFailed(t *testing.T) {
	done := submitServiceWithVolume(t, ampleHostCapacity(), serviceCreateFailingStartScript(strings.Repeat("c", 64), true))
	if done.State != "failed" || done.ErrorCode != "docker-container-create-rolled-back" || !strings.Contains(done.Message, "已回滚") {
		t.Fatalf("回滚已确认的失败不应是结果未知：%+v", done)
	}
}

// 回滚后回读发现容器仍在：结果未知，保留保护，不得冒充无变更。
func TestServiceStartFailureWithUnverifiedRollbackStaysUnknown(t *testing.T) {
	done := submitServiceWithVolume(t, ampleHostCapacity(), serviceCreateFailingStartScript(strings.Repeat("c", 64), false))
	if done.State != "unknown" {
		t.Fatalf("回滚未确认时必须保持结果未知：%+v", done)
	}
}

// 官方数据库镜像不走通用服务容器：这类部署必须经 database_provision 才能复用现有实例、
// 让面板持有凭据。提交前拒绝并指路，不建任务。
func TestSubmitServiceRedirectsOfficialDatabaseImages(t *testing.T) {
	imageID := strings.Repeat("b", 64)
	facade := capacityFacade(t, ampleHostCapacity(), func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == http.MethodGet && call.Path == "/images/json":
			return http.StatusOK, `[{"Id":"sha256:` + imageID + `"}]`, true
		case call.Method == http.MethodGet && call.Path == "/images/"+encodeEngineID("sha256:"+imageID)+"/json":
			return http.StatusOK, `{"Id":"sha256:` + imageID + `","Size":1000,"Created":"2026-11-26T00:00:00Z","RepoTags":["mysql:8.0"],"RepoDigests":[],"Config":{}}`, true
		}
		return 0, "", false
	})
	input := capacityServiceInput()
	input.Image, input.Name = "mysql:8.0@sha256:"+imageID, "shop-mysql"
	input.Credentials, input.Volumes = []string{"MYSQL_ROOT_PASSWORD"}, []string{"/var/lib/mysql"}
	_, err := facade.SubmitService(context.Background(), input)
	var rejected *AgentError
	if !errors.As(err, &rejected) || !rejected.NotDispatched || !strings.Contains(rejected.Message, "database_provision") {
		t.Fatalf("官方数据库镜像应在提交前被引导到 database_provision：%v", err)
	}
	assertNoTaskLedger(t, facade)
}

// 创建请求的响应异常（传输失败、201 但回执解不开）时，容器可能已在 Engine 产生：
// 必须按名称回读，发现是本次创建的容器（create-digest 匹配）就删除并再回读确认；
// 回读不到 404 且不是本次的容器时保持结果未知，不得声明无变更。
func serviceCreateUncertainScript(containerID, digest string, selfDigest bool) engineScript {
	// 名称占用检查发生在 create 之前：只有在 create 请求发出之后，按名称回读才看得到容器。
	created := false
	return func(call engineCall) (int, string, bool) {
		imageID := strings.Repeat("b", 64)
		switch {
		case call.Method == http.MethodPost && call.Path == "/containers/create":
			created = true
			// 201 但回执缺 ID（响应被截断）：与传输失败一样，容器可能已经产生。
			return http.StatusCreated, `{}`, true
		case call.Method == http.MethodGet && call.Path == "/containers/web/json":
			if !created {
				return http.StatusNotFound, "", true
			}
			// 非自身分支：回读到一个带别的摘要的容器（同名但不是本次请求创建的）。
			readDigest := digest
			if !selfDigest {
				readDigest = strings.Repeat("d", 64)
			}
			labels := `"elysian.managed":"true","elysian.agent.template":"service-v1","elysian.agent.create-digest":"` + readDigest + `"`
			body := `{"Id":"` + containerID + `","Name":"/web","Created":"2026-11-26T00:00:00Z","Image":"nginx@sha256:` + imageID + `","State":{"Status":"created"},"Config":{"Labels":{` + labels + `}},"HostConfig":{"NetworkMode":"none"},"Mounts":[]}`
			return http.StatusOK, body, true
		case call.Method == http.MethodGet && call.Path == "/containers/"+containerID+"/json":
			// 删除后的二次回读：确认已消失。
			return http.StatusNotFound, "", true
		case call.Method == http.MethodGet && call.Path == "/images/json":
			return http.StatusOK, `[{"Id":"sha256:` + imageID + `"}]`, true
		case call.Method == http.MethodGet && call.Path == "/images/"+encodeEngineID("sha256:"+imageID)+"/json":
			return http.StatusOK, `{"Id":"sha256:` + imageID + `","Size":1000,"Created":"2026-11-26T00:00:00Z","RepoTags":["nginx:1"],"RepoDigests":[],"Config":{}}`, true
		case call.Method == http.MethodPost && call.Path == "/volumes/create":
			return http.StatusCreated, `{"Name":"elysian-agent-0-` + strings.Repeat("1", 64) + `"}`, true
		case call.Method == http.MethodGet && call.Path == "/networks/elysian-agent-net":
			return http.StatusNotFound, "", true
		case call.Method == http.MethodPost && call.Path == "/networks/create":
			return http.StatusCreated, `{"Id":"net-1","Warning":""}`, true
		case call.Method == http.MethodGet && strings.HasPrefix(call.Path, "/volumes/"):
			// 卷的回读：确认已消失。
			return http.StatusNotFound, "", true
		case call.Method == http.MethodDelete && strings.HasPrefix(call.Path, "/containers/"):
			return http.StatusNoContent, "", true
		case call.Method == http.MethodDelete && strings.HasPrefix(call.Path, "/volumes/"):
			return http.StatusNoContent, "", true
		}
		return 0, "", false
	}
}

func TestServiceUncertainCreateReadsBackByNameAndRemovesOwnContainer(t *testing.T) {
	for name, selfDigest := range map[string]bool{"是本次创建的": true, "不是本次创建的": false} {
		t.Run(name, func(t *testing.T) {
			input := capacityServiceInput()
			input.Volumes = []string{"/data"}
			engine := newFakeEngine(serviceCreateUncertainScript(strings.Repeat("c", 64), serviceCreateDigest(input), selfDigest))
			facade := &AgentFacade{
				operationRoot: filepath.Join(t.TempDir(), "tasks"),
				service:       newDockerService(serviceDeps{transport: engine, mountRoot: "/srv", reservedPorts: []int{22, 48100, 48101}, selfContainerID: strings.Repeat("f", 64)}),
				authorize:     func(context.Context) error { return nil },
				credentials:   newAgentCredentialStore(filepath.Join(t.TempDir(), "agent-service-containers.json")),
				portOpener:    &recordingPortOpener{},
				hostCapacity:  ampleHostCapacity(),
			}
			task, err := facade.SubmitService(context.Background(), input)
			if err != nil {
				t.Fatal(err)
			}
			done := waitContainerOperation(t, facade, task.ID)
			deleted := false
			for _, call := range engine.Requests() {
				if call.Method == http.MethodDelete && strings.HasPrefix(call.Path, "/containers/") {
					deleted = true
				}
			}
			if selfDigest {
				if done.State != "failed" || done.ErrorCode != "docker-container-create-rolled-back" || !strings.Contains(done.Message, "已回滚") {
					t.Fatalf("回读确认本次容器已删后应是无变更失败：%+v", done)
				}
				if !deleted {
					t.Fatal("确认是本次创建的容器后应删除它")
				}
			} else {
				if done.State != "unknown" {
					t.Fatalf("回读发现不是本次的容器时必须保持结果未知：%+v", done)
				}
				if deleted {
					t.Fatal("不是本次创建的容器不得删除")
				}
			}
		})
	}
}

func TestServiceFirstVolumeTransportFailurePreservesUnknown(t *testing.T) {
	volume := "elysian-agent-0-" + capacityServiceInput().RequestID
	facade := capacityFacade(t, ampleHostCapacity(), func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == http.MethodPost && call.Path == "/volumes/create":
			return 0, "", false // Engine could have received the request.
		case call.Method == http.MethodGet && call.Path == "/volumes/"+volume:
			return http.StatusNotFound, "", true
		}
		return 0, "", false
	})
	input := capacityServiceInput()
	input.Volumes = []string{"/data"}
	task, err := facade.SubmitService(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	done := waitContainerOperation(t, facade, task.ID)
	if done.State != "unknown" || len(done.AttemptedVolumes) != 1 || done.AttemptedVolumes[0] != volume {
		t.Fatalf("首次建卷回执丢失应留有证据并保持未知：%+v", done)
	}
	for _, call := range facade.service.deps.transport.(*fakeEngine).Requests() {
		if call.Method == http.MethodGet && call.Path == "/volumes/"+volume {
			return
		}
	}
	t.Fatal("首次尝试的卷也必须回读")
}
