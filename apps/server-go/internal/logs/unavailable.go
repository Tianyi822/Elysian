package logs

import (
	"errors"
	"time"
)

// unavailableMessage 打不开库时查询族统一抛出的中文错误（路由层映射 500）。
const unavailableMessage = "日志数据库不可用"

// errLogStoreUnavailable 查询/清空/导入统一错误。
var errLogStoreUnavailable = errors.New(unavailableMessage)

// unavailableLogStore 打开失败时的回落（unavailableLogStore.ts 等价物）：
// 写入静默吞掉并计 failedWrites，查询抛中文错误，sweep 回 failed:1 空结果。
type unavailableLogStore struct {
	failedWrites int
}

// newUnavailableLogStore 构造不可用回落 store。
func newUnavailableLogStore() *unavailableLogStore {
	return &unavailableLogStore{}
}

// InsertRuntime 写入只计数。
func (s *unavailableLogStore) InsertRuntime(runtimeInsert) { s.failedWrites++ }

// InsertLogin 写入只计数。
func (s *unavailableLogStore) InsertLogin(loginInsert) { s.failedWrites++ }

// InsertOperation 写入只计数。
func (s *unavailableLogStore) InsertOperation(operationInsert) { s.failedWrites++ }

// ImportFile 抛不可用错误（导入方逐文件捕获、分片保留）。
func (s *unavailableLogStore) ImportFile(string, []string) (int, int, error) {
	return 0, 0, errLogStoreUnavailable
}

// QueryRuntime 查询回不可用错误。
func (s *unavailableLogStore) QueryRuntime(logListQuery) (logPage[RuntimeLogEntry], error) {
	return logPage[RuntimeLogEntry]{}, errLogStoreUnavailable
}

// QueryLogin 查询回不可用错误。
func (s *unavailableLogStore) QueryLogin(loginLogListQuery) (logPage[LoginLogEntry], error) {
	return logPage[LoginLogEntry]{}, errLogStoreUnavailable
}

// QueryOperation 查询回不可用错误。
func (s *unavailableLogStore) QueryOperation(operationLogListQuery) (logPage[OperationLogEntry], error) {
	return logPage[OperationLogEntry]{}, errLogStoreUnavailable
}

// Clear 清空抛不可用错误。
func (s *unavailableLogStore) Clear(string) (logClearStats, error) {
	return logClearStats{}, errLogStoreUnavailable
}

// Sweep 回 failed:1 空结果。
func (s *unavailableLogStore) Sweep(string, time.Time) logSweepResult {
	return emptySweep(1)
}

// Storage 全零 + 透传巡检字段与 failedWrites。
func (s *unavailableLogStore) Storage(lastSweepAt *string, trimmedBySize bool) LogStorageStats {
	return LogStorageStats{
		LastSweepAt:   lastSweepAt,
		TrimmedBySize: trimmedBySize,
		FailedWrites:  int64(s.failedWrites),
	}
}

// Counters 写失败计数。
func (s *unavailableLogStore) Counters() (int, int) { return 0, s.failedWrites }

// Close 空操作。
func (s *unavailableLogStore) Close() error { return nil }
