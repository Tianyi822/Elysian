package harness

import (
	"errors"
	"testing"
)

func TestAgentWritableRejectsClosedRecordFaultStorageAndDispatch(t *testing.T) {
	t.Run("closed", func(t *testing.T) {
		m, _ := sessionAPIManager(t)
		m.closed = true
		runtimeErrorCode(t, m.agentWritable(), "runtime-stopped")
	})

	t.Run("record fault", func(t *testing.T) {
		m, _ := sessionAPIManager(t)
		m.store.failRecords(errors.New("disk unavailable"))
		runtimeErrorCode(t, m.agentWritable(), "record-storage-unavailable")
	})

	t.Run("storage error", func(t *testing.T) {
		m, _ := sessionAPIManager(t)
		m.storageError = true
		runtimeErrorCode(t, m.agentWritable(), "storage-unavailable")
	})

	t.Run("dispatch guard", func(t *testing.T) {
		m, _ := sessionAPIManager(t)
		m.deps.DispatchGuard = func() error {
			return &Error{Status: 503, Code: "dispatch-blocked", Message: "停止派发"}
		}
		runtimeErrorCode(t, m.agentWritable(), "dispatch-blocked")
	})
}
