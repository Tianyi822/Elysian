package database

import (
	"errors"
	"testing"
)

func TestProvisionRejectsUnreadableRegistry(t *testing.T) {
	fixture := newProvisionFixture(t, reusableMySQL, reusableMySQLRows, mysqlImages("8.0"), ampleMemory())
	fixture.registry.broken = errors.New("registry unavailable")
	task, err := fixture.facade.SubmitProvision(t.Context(), provisionInput("shop"))
	var rejected *AgentProvisionError
	if !errors.As(err, &rejected) || !rejected.NotDispatched || task.ID != "" {
		t.Fatalf("登记不可读必须在受理前拒绝：task=%q err=%v", task.ID, err)
	}
	assertNoProvisionTask(t, fixture)
}
