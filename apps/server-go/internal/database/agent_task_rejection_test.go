package database

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestAgentDatabaseRejectsInvalidCreateBeforeAcceptance(t *testing.T) {
	for _, tc := range []struct{ name, expected, version string }{
		{"screenshot", "absent", "latest"},
		{"wrong_expected_only", "absent", "8.4"},
		{"latest_only", "missing", "latest"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newServiceFixture("8.4.7")
			facade := &AgentFacade{service: fixture.service, taskRoot: t.TempDir(), authorize: func(context.Context) error { return nil }}
			t.Cleanup(func() { _ = facade.Close(context.Background()) })
			input := agentCreateTaskInput()
			input.Create.Expected, input.Create.VersionTag = tc.expected, tc.version
			_, err := facade.SubmitTask(context.Background(), strings.Repeat("a", 64), input)
			var rejected *AgentTaskRejectedError
			if !errors.As(err, &rejected) || len(facade.tasks) != 0 || len(fixture.docker.createCalls) != 0 {
				t.Fatalf("expected pre-dispatch rejection: err=%v tasks=%d creates=%d", err, len(facade.tasks), len(fixture.docker.createCalls))
			}
			if !strings.Contains(rejected.Message, "未接受") || !strings.Contains(rejected.Message, map[bool]string{true: "missing", false: "latest"}[tc.expected != "missing"]) {
				t.Fatalf("缺少可纠正的原因：%v", err)
			}
		})
	}
}

func assertNotTaskRejection(t *testing.T, err error) {
	t.Helper()
	var rejected *AgentTaskRejectedError
	if errors.As(err, &rejected) {
		t.Fatalf("任务身份冲突、未知结果或存储故障被误当成参数拒绝：%v", err)
	}
}

func TestAgentDatabaseAuthorizationFailureIsNotCorrectable(t *testing.T) {
	fixture := newServiceFixture("8.4.7")
	facade := &AgentFacade{service: fixture.service, taskRoot: t.TempDir(), authorize: func(context.Context) error { return errors.New("未授权") }}
	_, err := facade.SubmitTask(context.Background(), strings.Repeat("a", 64), agentCreateTaskInput())
	if err == nil {
		t.Fatal("授权失败仍接受任务")
	}
	assertNotTaskRejection(t, err)
}
