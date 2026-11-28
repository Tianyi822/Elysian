package harness

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/tools"
)

// 容量预检与数据库实例发现是只读的已审核平台读取，新聊天免审批调用。
func TestCapacityAndDatabaseInstanceDiscoveryAreConfirmedPlatformReads(t *testing.T) {
	for _, name := range []string{"docker_host_capacity", "database_instances"} {
		capability := Capability{Name: name, Source: "builtin", ReadOnly: true, Metadata: tools.Metadata{Domain: "docker", Exposure: "agent", ReadOnly: true}}
		if !confirmedPlatformRead(capability) {
			t.Fatalf("%s 应是免审批的已审核平台读取", name)
		}
	}
	if confirmedPlatformRead(Capability{Name: "database_provision", Source: "builtin", ReadOnly: true, Metadata: tools.Metadata{Domain: "database", Exposure: "agent", ReadOnly: true}}) {
		t.Fatal("数据库部署是写效应，不得按只读工具放行")
	}
}

// 缺任务 ID 的核实契约按已审核的精确版本放行：create_service v3 与 v4。
func TestMissingTaskVerificationAcceptsReviewedCreateServiceVersions(t *testing.T) {
	for _, version := range []string{"3", "4"} {
		capability := Capability{Name: "docker_container_create_service", Source: "builtin", Metadata: tools.Metadata{Async: true, Version: version}}
		if !supportsMissingTaskVerification(capability) {
			t.Fatalf("create_service v%s 应支持缺任务 ID 的核实", version)
		}
	}
	future := Capability{Name: "docker_container_create_service", Source: "builtin", Metadata: tools.Metadata{Async: true, Version: "5"}}
	if supportsMissingTaskVerification(future) {
		t.Fatal("未经审核的版本不得放行缺任务 ID 的核实")
	}
}

// 数据库域的新工具不在退役名单里；领域说明与搜索别名覆盖「复用优先的数据库部署」。
func TestNewDatabaseToolsAreNotRetiredAndDiscoverable(t *testing.T) {
	for _, name := range []string{"database_list", "database_create", "database_task_status", "database_container_remove"} {
		if !retiredDatabaseTool(name) {
			t.Errorf("已退役的 %s 必须继续对新聊天隐藏", name)
		}
	}
	for _, name := range []string{"database_instances", "database_provision"} {
		if retiredDatabaseTool(name) {
			t.Errorf("新工具 %s 不得被前缀匹配误伤", name)
		}
	}
	if !strings.Contains(state.DomainBoundaries["database"], "复用") || !strings.Contains(state.DomainBoundaries["database"], "接管") {
		t.Fatalf("数据库领域说明应讲清复用与接管：%s", state.DomainBoundaries["database"])
	}
	if !strings.Contains(state.DomainBoundaries["docker"], "容量") {
		t.Fatalf("docker 领域说明应提到容量核对：%s", state.DomainBoundaries["docker"])
	}
	if keywords := discoveryDomainKeywords("database", "builtin"); !strings.Contains(keywords, "数据库") {
		t.Fatalf("数据库领域缺少搜索别名：%s", keywords)
	}
	for _, version := range []string{"1"} {
		capability := Capability{Name: "database_provision", Source: "builtin", Metadata: tools.Metadata{Async: true, Version: version}}
		if !supportsMissingTaskVerification(capability) {
			t.Fatalf("database_provision v%s 应支持缺任务 ID 的核实", version)
		}
	}
}

// 已有会话保存的工具清单里没有这两个工具：续聊与编辑重发必须补齐，否则模型会被
// create_service 的指引引向一个搜不到的工具。只补已审核的两个名字，不回写会话环境。
func TestAuditedDatabaseToolsReachContinuedChats(t *testing.T) {
	m := &Manager{deps: Deps{Tools: &dockerSelectionTools{schemas: []tools.PublicSchema{
		{Name: "database_instances", Metadata: tools.Metadata{Domain: "database", Exposure: "agent", ReadOnly: true}},
		{Name: "database_provision", Metadata: tools.Metadata{Domain: "database", Exposure: "agent"}},
		{Name: "database_create", Metadata: tools.Metadata{Domain: "database", Exposure: "agent"}},
		{Name: "database_unreviewed", Metadata: tools.Metadata{Domain: "database", Exposure: "agent"}},
		{Name: "database_human", Metadata: tools.Metadata{Domain: "database", Exposure: "human"}},
		{Name: "docker_images_list", Metadata: tools.Metadata{Domain: "docker", Exposure: "agent"}},
	}}}}
	before := Environment{Tools: []string{"already_selected", "database_create"}, TrustedReadOnly: []string{"database_create"}}
	got := m.withCurrentAgentTools(before)
	want := []string{"already_selected", "database_instances", "database_provision", "docker_images_list"}
	if !reflect.DeepEqual(got.Tools, want) {
		t.Fatalf("续聊应补齐已审核的数据库工具并去掉退役名：%v", got.Tools)
	}
	if len(got.TrustedReadOnly) != 0 {
		t.Fatalf("退役的只读信任仍被继承：%v", got.TrustedReadOnly)
	}
	if !reflect.DeepEqual(before.Tools, []string{"already_selected", "database_create"}) {
		t.Fatalf("补齐改写了保存的环境：%v", before.Tools)
	}
}

// 缺任务 ID 的核实对 database_provision 也要走通：未知操作按未受理核实后封存原请求。
func TestMissingTaskVerificationSealsUnacceptedDatabaseProvision(t *testing.T) {
	ctx := context.Background()
	s, _, _, _ := budgetSourceFixture(t)
	m := &Manager{store: s, ctx: ctx, deps: Deps{Now: func() time.Time { return runtimeStoreTestTime }}, wake: make(chan struct{}, 1)}
	old := createRuntimeTestRun(t, s, "db-orphan", runtimeStoreTestTime)
	op := Operation{ID: "db-orphan-op", RunID: old.ID, TaskID: old.TaskID, Status: "unknown", CallID: "db-call", DispatchID: "db-dispatch",
		ArgumentsJSON: `{"engine":"MySQL","version":"8.0","database":"shop","requestId":"` + strings.Repeat("a", 64) + `"}`,
		Capability:    Capability{Name: "database_provision", Source: "builtin", Metadata: tools.Metadata{Async: true, Version: "1"}},
		Task:          &tools.TaskReference{Domain: "database-provision", RequestID: strings.Repeat("a", 64)}}
	if err := s.write(ctx, "db-orphan-fixture", func(tx sessionstore.Tx) error {
		old.Status, old.EndReason, old.Error = StateInterrupted, "outcome-unknown", &Failure{Code: "outcome-unknown", Message: "原操作结果未知"}
		if err := saveRun(ctx, tx, &old); err != nil {
			return err
		}
		if err := saveOperation(ctx, tx, op); err != nil {
			return err
		}
		if err := saveBarrier(ctx, tx, ExecutionBarrier{ID: "db-barrier", RunID: old.ID, OperationID: op.ID, Status: "unknown"}); err != nil {
			return err
		}
		if err := saveCall(ctx, tx, Call{ID: op.CallID, RunID: old.ID, OperationID: op.ID, Tool: op.Capability.Name, Status: StateInterrupted}); err != nil {
			return err
		}
		return saveResourceLease(ctx, tx, ResourceLease{ID: op.ID, RunID: old.ID, OperationID: op.ID, State: "unknown"})
	}); err != nil {
		t.Fatal(err)
	}
	m.deps.VerifyTask = func(_ context.Context, v tools.TaskVerification) (tools.TaskReference, error) {
		if v.Task.Domain != "database-provision" || v.Tool != "database_provision" || v.ToolVersion != "1" {
			t.Fatalf("核实请求身份不符：%+v", v)
		}
		return tools.TaskReference{Domain: v.Task.Domain, ID: "sealed-db", RequestID: v.Task.RequestID, Target: "MySQL/8.0/shop", Digest: strings.Repeat("d", 64)}, nil
	}
	m.deps.InspectTask = func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
		return tools.TaskStatus{Outcome: tools.TaskFailed, ErrorCode: "database-provision-not-accepted", Error: "原提交未受理，未执行业务变更", Evidence: &tools.ExecutionEvidence{Execution: "not-started", Changes: "none"}}, nil
	}
	after, err := m.VerifyRecovery(ctx, old.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != StateInterrupted {
		t.Fatalf("核实后的运行状态不符：%+v", after)
	}
}
