package harness

func (m *Manager) agentWritable() error {
	if m.closed {
		return closedError()
	}
	if err := m.store.recordsFault(); err != nil {
		return &Error{503, "record-storage-unavailable", err.Error()}
	}
	if m.storageError {
		return &Error{503, "storage-unavailable", "运行存储不可用"}
	}
	if m.deps.DispatchGuard != nil {
		return m.deps.DispatchGuard()
	}
	return nil
}
