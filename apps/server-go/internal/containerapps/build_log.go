package containerapps

import (
	"path/filepath"

	"elysian/server/internal/tasklog"
)

// buildLogTracker 单任务日志写入记账（总量截断用）。
type buildLogTracker struct {
	written   int64
	truncated bool
}

// LogPath 任务日志路径（日志端点读文件用）。
func (m *BuildManager) LogPath(taskID string) string {
	return filepath.Join(m.deps.LogRoot, taskID+".log")
}

// log 写一行任务日志：单行截 128 KiB，总量超限后丢弃后续行并只记一次截断提示。
func (m *BuildManager) log(taskID, text string) {
	if len(text) > 128*1024 {
		text = text[:128*1024]
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	tracker := m.logTrackers[taskID]
	if tracker == nil {
		tracker = &buildLogTracker{}
		m.logTrackers[taskID] = tracker
	}
	if tracker.truncated {
		return
	}
	line := text + "\n"
	if tracker.written+int64(len(line)) > m.limits.LogBytes {
		notice := buildLogTruncated + "\n"
		if tracker.written+int64(len(notice)) <= m.limits.LogBytes {
			m.appendLog(taskID, notice)
			tracker.written += int64(len(notice))
		}
		tracker.truncated = true
		return
	}
	m.appendLog(taskID, line)
	tracker.written += int64(len(line))
}

// appendLog 追加写日志文件（调用方持锁）。
func (m *BuildManager) appendLog(taskID, text string) {
	_ = tasklog.Append(m.LogPath(taskID), text, 0)
}
