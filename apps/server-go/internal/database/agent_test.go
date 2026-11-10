package database

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"elysian/server/internal/contract"
	"elysian/server/internal/shared"
)

func TestAgentDiscoverErrorsAreSafeAndCorrectable(t *testing.T) {
	fixture := newServiceFixture("8.4.2")
	facade := &AgentFacade{service: fixture.service, authorize: func(context.Context) error { return nil }}
	for _, version := range []string{"latest", "LATEST", "", "8.0; rm -rf /"} {
		_, err := facade.Discover(context.Background(), "MySQL", version)
		var failure *AgentDiscoveryError
		if !errors.As(err, &failure) || failure.Code != "database-version-invalid" || !strings.Contains(failure.Message, "latest") || !strings.Contains(failure.Message, "镜像列表") {
			t.Fatalf("非法版本应返回可纠正错误：%+v", err)
		}
	}
	value, err := facade.Discover(context.Background(), "MySQL", "8.0")
	raw, _ := json.Marshal(value)
	if err != nil || !strings.Contains(string(raw), `"images":[]`) || !strings.Contains(string(raw), `"containers":[]`) {
		t.Fatalf("无匹配项必须成功返回空列表：%s %v", raw, err)
	}
	secret := "ENGINE_PRIVATE_RESPONSE"
	fixture.service.deps.listImages = func(context.Context) ([]contract.ContainerImage, error) { return nil, errors.New(secret) }
	_, err = facade.Discover(context.Background(), "MySQL", "8.0")
	var failure *AgentDiscoveryError
	if !errors.As(err, &failure) || failure.Code != "database-discovery-failed" || strings.Contains(err.Error(), secret) || errors.Unwrap(err) != nil {
		t.Fatalf("引擎响应不得进入公开错误：%v", err)
	}
	for _, cause := range []error{context.Canceled, context.DeadlineExceeded} {
		fixture.service.deps.listImages = func(context.Context) ([]contract.ContainerImage, error) { return nil, cause }
		_, err = facade.Discover(context.Background(), "MySQL", "8.0")
		if !errors.Is(err, cause) || errors.As(err, &failure) {
			t.Fatalf("取消与超时不得变为业务错误：%v", err)
		}
	}
	denied := errors.New("授权撤销")
	facade.authorize = func(context.Context) error { return denied }
	_, err = facade.Discover(context.Background(), "MySQL", "latest")
	if !errors.Is(err, denied) {
		t.Fatalf("参数错误不得掩盖授权拒绝：%v", err)
	}
}

func TestAgentDatabaseRequiresManagedExactRegistrationAndAuthority(t *testing.T) {
	fixture := newServiceFixture("8.4.2")
	row := databaseRecord{ID: "db", Engine: engineMySQL, Name: "orders", Source: sourceAdopted, State: stateActive, User: databaseSecret{Username: "account", Password: "DO_NOT_EXPOSE"}}
	fixture.registry.rows = []databaseRecord{row}
	calls := 0
	facade := &AgentFacade{service: fixture.service, authorize: func(context.Context) error { calls++; return nil }}
	var rejected *AgentLifecycleRejectedError
	if _, err := facade.Lifecycle(context.Background(), row.ID, agentRecordDigest(row), "remove"); !errors.As(err, &rejected) {
		t.Fatalf("adopted database mutation accepted: %v", err)
	}
	row.Source = sourceManaged
	fixture.registry.rows = []databaseRecord{row}
	if _, err := facade.Lifecycle(context.Background(), row.ID, "old-version", "remove"); !errors.As(err, &rejected) {
		t.Fatalf("stale registration mutation accepted: %v", err)
	}
	if _, err := facade.Lifecycle(context.Background(), row.ID, agentRecordDigest(row), "raw-sql"); !errors.As(err, &rejected) {
		t.Fatalf("arbitrary operation accepted: %v", err)
	}
	if calls != 3 {
		t.Fatalf("authorization calls=%d", calls)
	}
	if len(fixture.docker.removeCalls) != 0 {
		t.Fatal("rejected mutation reached Docker")
	}
	if _, err := (&AgentFacade{service: fixture.service}).List(context.Background()); err == nil {
		t.Fatal("missing authority accepted")
	}
	raw, _ := json.Marshal(map[string]string{"version": agentRecordDigest(row)})
	if strings.Contains(string(raw), row.User.Password) {
		t.Fatal("version leaked password")
	}
}

// failingListRegistry 注入登记读取故障，模拟存储不可用。
type failingListRegistry struct {
	*memoryDatabaseRegistry
}

func (r *failingListRegistry) list() ([]databaseRecord, error) {
	return nil, errors.New("REGISTRY_STORAGE_BROKEN")
}

func TestAgentLifecyclePrecheckIsTyped(t *testing.T) {
	fixture := newServiceFixture("8.4.2")
	managed := databaseRecord{ID: "db", Engine: engineMySQL, Name: "orders", Source: sourceManaged, State: stateActive, ContainerID: strings.Repeat("c", 64), VolumeName: "elysian-db-" + strings.Repeat("0", 36)}
	cases := []struct {
		name     string
		rows     []databaseRecord
		id       string
		expected string
		action   string
		message  string
	}{
		{"未知登记", nil, "missing", "any", "remove", "数据库不存在，请用 database_list 读取精确登记 ID"},
		{"非面板受管", []databaseRecord{{ID: "db", Engine: engineMySQL, Name: "orders", Source: sourceAdopted, State: stateActive}}, "db", "any", "remove", "仅允许操作面板受管数据库"},
		{"陈旧登记版本", []databaseRecord{managed}, "db", "old-version", "remove", "数据库登记版本已变化，请重新读取并审批"},
		{"未开放操作", []databaseRecord{managed}, "db", agentRecordDigest(managed), "raw-sql", "数据库操作未开放"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fixture.registry.rows = testCase.rows
			facade := &AgentFacade{service: fixture.service, authorize: func(context.Context) error { return nil }}
			_, err := facade.Lifecycle(context.Background(), testCase.id, testCase.expected, testCase.action)
			var rejected *AgentLifecycleRejectedError
			if !errors.As(err, &rejected) || rejected.Message != testCase.message {
				t.Fatalf("预检拒绝应保留类型与精确文案，实际 %v", err)
			}
			if len(fixture.docker.removeCalls) != 0 {
				t.Fatal("预检拒绝不得派发删除")
			}
		})
	}
	t.Run("start 兄弟登记", func(t *testing.T) {
		sibling := managed
		sibling.ID, sibling.Name = "sibling", "orders2"
		fixture.registry.rows = []databaseRecord{managed, sibling}
		facade := &AgentFacade{service: fixture.service, authorize: func(context.Context) error { return nil }}
		_, err := facade.Lifecycle(context.Background(), "db", agentRecordDigest(managed), "start")
		var rejected *AgentLifecycleRejectedError
		if !errors.As(err, &rejected) || rejected.Message != "实例中还有其他逻辑库，不能通过单库授权改变整个实例状态" {
			t.Fatalf("兄弟登记应预检拒绝，实际 %v", err)
		}
	})
	t.Run("登记不可读不是预检拒绝", func(t *testing.T) {
		service := newDatabaseService(serviceDeps{registry: &failingListRegistry{fixture.registry}, docker: fixture.docker, protocol: fixture.protocol})
		facade := &AgentFacade{service: service, authorize: func(context.Context) error { return nil }}
		_, err := facade.Lifecycle(context.Background(), "db", agentRecordDigest(managed), "remove")
		var rejected *AgentLifecycleRejectedError
		if errors.As(err, &rejected) {
			t.Fatalf("存储失败不得冒充预检拒绝：%v", err)
		}
		var failure *AgentLifecycleError
		if !errors.As(err, &failure) || strings.Contains(err.Error(), "REGISTRY_STORAGE_BROKEN") {
			t.Fatalf("存储失败应收敛为固定文案的执行失败：%v", err)
		}
	})
}

func TestAgentLifecycleExecutionFailureKeepsLocalReason(t *testing.T) {
	fixture := newServiceFixture("8.4")
	response, err := fixture.service.Create(context.Background(), newCreateRequest(createTarget{Kind: "new", ImageID: testImageID, ContainerName: "mysql-db"}, scopeLocalhost, nil))
	if err != nil {
		t.Fatal(err)
	}
	rows, _ := fixture.registry.list()
	facade := &AgentFacade{service: fixture.service, authorize: func(context.Context) error { return nil }}
	t.Run("引擎正文不透传", func(t *testing.T) {
		fixture.docker.removeErr = errors.New("ENGINE_PRIVATE_RESPONSE")
		defer func() { fixture.docker.removeErr = nil }()
		_, err := facade.Lifecycle(context.Background(), response.Instance.ID, agentRecordDigest(rows[0]), "remove-container")
		var failure *AgentLifecycleError
		if !errors.As(err, &failure) || failure.Code != "database-lifecycle-failed" || failure.Message != "数据库操作失败，请回读实际状态，不能自动重试" {
			t.Fatalf("执行失败应收敛为固定兜底文案：%v", err)
		}
		if errors.Unwrap(err) != nil || strings.Contains(err.Error(), "ENGINE_PRIVATE_RESPONSE") {
			t.Fatalf("底层错误链不得保留：%v", err)
		}
	})
	t.Run("域层固定中文保留", func(t *testing.T) {
		fixture.docker.removeErr = &shared.InvalidRequestError{Status: 409, Message: "数据库持久卷身份核对失败"}
		defer func() { fixture.docker.removeErr = nil }()
		_, err := facade.Lifecycle(context.Background(), response.Instance.ID, agentRecordDigest(rows[0]), "remove-container")
		var failure *AgentLifecycleError
		if !errors.As(err, &failure) || failure.Code != "database-lifecycle-failed" || failure.Message != "数据库持久卷身份核对失败" {
			t.Fatalf("InvalidRequestError 契约文案应原样保留：%v", err)
		}
	})
}

func TestAgentDatabaseCreateGeneratesCredentialsAndFixesNetwork(t *testing.T) {
	fixture := newServiceFixture("8.4.7")
	calls := 0
	facade := &AgentFacade{service: fixture.service, authorize: func(context.Context) error { calls++; return nil }}
	input := AgentCreate{ID: "new:orders-agent", Expected: "missing", Engine: engineMySQL, VersionTag: "8.4", Name: "orders", ImageID: testImageID, ContainerName: "orders-agent"}
	value, err := facade.Create(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 || len(fixture.docker.createCalls) != 1 {
		t.Fatalf("calls authorization=%d docker=%d", calls, len(fixture.docker.createCalls))
	}
	created := fixture.docker.createCalls[0]
	if created.accessScope != scopeContainerNet || created.hostPort != nil {
		t.Fatal("Agent created public host database")
	}
	rows, _ := fixture.registry.list()
	if len(rows) != 1 || len(rows[0].User.Password) < 12 || rows[0].User.Username == "root" {
		t.Fatal("backend credentials not generated")
	}
	raw, _ := json.Marshal(value)
	if strings.Contains(string(raw), rows[0].User.Password) || strings.Contains(string(raw), rows[0].Admin.Password) || strings.Contains(string(raw), rows[0].User.Username) {
		t.Fatalf("credentials leaked: %s", raw)
	}
	input.ID = "new:other-name"
	if _, err := facade.Create(context.Background(), input); err == nil {
		t.Fatal("grant identity did not bind new container name")
	}
	anchor := rows[0]
	if _, err := facade.Create(context.Background(), AgentCreate{ID: anchor.ID, Expected: "stale", Engine: anchor.Engine, VersionTag: anchor.VersionTag, Name: "another"}); err == nil {
		t.Fatal("stale managed create accepted")
	}
	fixture.registry.rows = append(fixture.registry.rows, databaseRecord{ID: "other", ContainerID: anchor.ContainerID})
	if _, err := facade.Lifecycle(context.Background(), anchor.ID, agentRecordDigest(anchor), "stop"); err == nil {
		t.Fatal("single database grant stopped shared instance")
	}
}
