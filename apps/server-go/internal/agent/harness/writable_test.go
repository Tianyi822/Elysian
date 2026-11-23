package harness

import (
	"context"
	"errors"
	"sync"
	"testing"
)

func TestAgentWritableGuardRechecksRecordFault(t *testing.T) {
	m, _ := sessionAPIManager(t)
	entered, release := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	m.deps.DispatchGuard = func() error { close(entered); <-release; return nil }
	result, done := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(done)
		_, err := m.PutWorkflowDefinition(context.Background(), "", 0, WorkflowDefinition{})
		result <- err
	}()
	defer func() { unblock(); <-done }()
	awaitGuard(t, m, entered)
	fixture(m).failRecords(errors.New("副本不可用"))
	unblock()
	runtimeErrorCode(t, <-result, "record-storage-unavailable")
}

func TestAgentWritableRejectsClosedRecordFaultStorageAndDispatch(t *testing.T) {
	update := func(m *Manager) error {
		_, err := m.PutWorkflowDefinition(context.Background(), "", 0, WorkflowDefinition{})
		return err
	}
	t.Run("closed", func(t *testing.T) {
		m, _ := sessionAPIManager(t)
		m.closed = true
		runtimeErrorCode(t, update(m), "runtime-stopped")
	})

	t.Run("record fault", func(t *testing.T) {
		m, _ := sessionAPIManager(t)
		fixture(m).failRecords(errors.New("disk unavailable"))
		runtimeErrorCode(t, update(m), "record-storage-unavailable")
	})

	t.Run("storage error", func(t *testing.T) {
		m, _ := sessionAPIManager(t)
		m.storageError = true
		runtimeErrorCode(t, update(m), "storage-unavailable")
	})

	t.Run("dispatch guard", func(t *testing.T) {
		m, _ := sessionAPIManager(t)
		m.deps.DispatchGuard = func() error {
			return &Error{Status: 503, Code: "dispatch-blocked", Message: "停止派发"}
		}
		runtimeErrorCode(t, update(m), "dispatch-blocked")
	})
}
