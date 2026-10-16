package logs

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"elysian/server/internal/seam"
)

func TestAgentLogsOmitUntrustedTextAndConsumeOnce(t *testing.T) {
	svc, _ := newTestService()
	secret := "DO_NOT_EXPOSE_CREDENTIAL"
	svc.Runtime("info", secret, secret)
	status := 200
	svc.RecordOperation(seam.OperationRecord{Category: "files", Action: secret, Target: &secret, Summary: &secret, Method: "POST", Path: secret, Result: "success", HTTPStatus: &status})
	svc.RecordLogin(LoginRecord{IP: "192.0.2.5", UserAgent: secret, Status: "success"})
	calls := 0
	facade := NewAgentFacade(svc, func(context.Context) error { calls++; return nil })
	for _, category := range []string{"runtime", "operation", "login"} {
		value, err := facade.Read(context.Background(), category, 10)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(value)
		if strings.Contains(string(raw), secret) {
			t.Fatalf("sensitive log text leaked: %s", raw)
		}
	}
	if calls != 3 {
		t.Fatalf("authorization calls=%d", calls)
	}
	if agentLogAction("修改 SSH 监听端口") != "修改 SSH 监听端口" || agentLogAction(secret) == secret {
		t.Fatal("safe action projection does not preserve server labels")
	}
	if _, err := facade.Read(context.Background(), "runtime", 101); err == nil {
		t.Fatal("unbounded query accepted")
	}
	if _, err := NewAgentFacade(svc, nil).Read(context.Background(), "runtime", 10); err == nil {
		t.Fatal("unauthorized query accepted")
	}
}
