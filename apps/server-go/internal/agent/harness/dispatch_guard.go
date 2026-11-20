package harness

// checkDispatchGuard 查询外部维护状态，不持有 Manager 锁。调用方随后检查本地状态。
func (m *Manager) checkDispatchGuard() error {
	m.mu.Lock()
	guard := m.deps.DispatchGuard
	closed := m.closed
	m.mu.Unlock()
	if !closed && guard != nil {
		return guard()
	}
	return nil
}
