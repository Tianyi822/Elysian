package harness

func (m *Manager) agentWritableLocked(guardErr error) error {
	if m.closed {
		return closedError()
	}
	if err := m.store.DispatchError(); err != nil {
		return &Error{Status: 503, Code: "record-storage-unavailable", Message: err.Error()}
	}
	if m.storageError {
		return &Error{Status: 503, Code: "storage-unavailable", Message: "运行存储不可用"}
	}
	return guardErr
}
