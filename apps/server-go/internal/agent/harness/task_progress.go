package harness

import (
	"context"

	"elysian/server/internal/agent/tools"
)

// 进度是可替换的展示快照；权威记录仍由各域保存。终态、租约和预算不由进度决定。
type taskProgressObservation struct {
	Task     tools.TaskReference
	Progress *tools.TaskProgress
}

func cloneTaskProgress(progress *tools.TaskProgress) *tools.TaskProgress {
	if progress == nil {
		return nil
	}
	copy := *progress
	if copy.CurrentBytes != nil {
		value := *copy.CurrentBytes
		copy.CurrentBytes = &value
	}
	if copy.TotalBytes != nil {
		value := *copy.TotalBytes
		copy.TotalBytes = &value
	}
	return &copy
}

func (m *Manager) observeTaskProgress(expected Operation, progress *tools.TaskProgress) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.storageError || expected.Task == nil {
		return
	}
	current, err := readOperation(context.Background(), m.store.db, expected.ID)
	if err != nil || current.Task == nil || *current.Task != *expected.Task || (current.Status != StateWaitingTask && current.Status != "unknown") {
		return // 删除或完成期间迟到的观察结果不得复活任务。
	}
	if progress == nil {
		delete(m.taskProgress, expected.ID)
		return
	}
	if m.taskProgress == nil {
		m.taskProgress = make(map[string]taskProgressObservation)
	}
	m.taskProgress[expected.ID] = taskProgressObservation{Task: *expected.Task, Progress: cloneTaskProgress(progress)}
}
