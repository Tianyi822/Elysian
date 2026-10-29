package database

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"elysian/server/internal/contract"
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
	if _, err := facade.Lifecycle(context.Background(), row.ID, agentRecordDigest(row), "remove"); err == nil {
		t.Fatal("adopted database mutation accepted")
	}
	row.Source = sourceManaged
	fixture.registry.rows = []databaseRecord{row}
	if _, err := facade.Lifecycle(context.Background(), row.ID, "old-version", "remove"); err == nil {
		t.Fatal("stale registration mutation accepted")
	}
	if _, err := facade.Lifecycle(context.Background(), row.ID, agentRecordDigest(row), "raw-sql"); err == nil {
		t.Fatal("arbitrary operation accepted")
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
