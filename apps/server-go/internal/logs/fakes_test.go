package logs

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"elysian/server/internal/seam"
)

/*
 * 测试假件：内存 store（按表分列、可注入阻塞与 canned 结果）、采集 sink 服务
 *（收进数组供断言）、路由 fake 服务（记录收到的查询与清空调用）。
 */

// fakeStore 内存 store：按类别分列保存插入，Clear/Sweep 可注入 canned 结果与阻塞。
type fakeStore struct {
	mu sync.Mutex

	runtimeRows   []runtimeInsert
	loginRows     []loginInsert
	operationRows []operationInsert

	nextID int64

	clearErr   error
	clearCalls []string

	sweepBlock     chan struct{}
	sweepCalls     int
	sweepResults   map[string]logSweepResult
	storageFixture LogStorageStats

	lastRuntimeQuery   *logListQuery
	lastOperationQuery *operationLogListQuery
	lastLoginQuery     *loginLogListQuery

	activeMaintenance  atomic.Int64
	overlapMaintenance atomic.Bool
}

// newFakeStore 构造（canned sweep 结果按类别缺省为空结果）。
func newFakeStore() *fakeStore {
	return &fakeStore{
		nextID:       0,
		sweepResults: map[string]logSweepResult{},
	}
}

// beginMaintenance 维护操作互斥探针。
func (f *fakeStore) beginMaintenance() {
	if f.activeMaintenance.Add(1) > 1 {
		f.overlapMaintenance.Store(true)
	}
}

// endMaintenance 结束一次维护操作。
func (f *fakeStore) endMaintenance() { f.activeMaintenance.Add(-1) }

// InsertRuntime 记录插入。
func (f *fakeStore) InsertRuntime(input runtimeInsert) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.runtimeRows = append(f.runtimeRows, input)
}

// InsertLogin 记录插入。
func (f *fakeStore) InsertLogin(input loginInsert) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loginRows = append(f.loginRows, input)
}

// InsertOperation 记录插入。
func (f *fakeStore) InsertOperation(input operationInsert) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.operationRows = append(f.operationRows, input)
}

// ImportFile 空实现。
func (f *fakeStore) ImportFile(string, []string) (int, int, error) { return 0, 0, nil }

// QueryRuntime 逆序返回插入行（id 递增的字符串）。
func (f *fakeStore) QueryRuntime(query logListQuery) (logPage[RuntimeLogEntry], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	queryCopy := query
	f.lastRuntimeQuery = &queryCopy
	entries := []RuntimeLogEntry{}
	for i := len(f.runtimeRows) - 1; i >= 0; i-- {
		row := f.runtimeRows[i]
		f.nextID++
		entries = append(entries, RuntimeLogEntry{
			ID: formatInt(f.nextID), At: row.At, Level: row.Level, Source: row.Source, Message: row.Message,
		})
	}
	return logPage[RuntimeLogEntry]{Entries: entries, Total: int64(len(entries))}, nil
}

// QueryLogin 逆序返回。
func (f *fakeStore) QueryLogin(query loginLogListQuery) (logPage[LoginLogEntry], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	queryCopy := query
	f.lastLoginQuery = &queryCopy
	entries := []LoginLogEntry{}
	for i := len(f.loginRows) - 1; i >= 0; i-- {
		row := f.loginRows[i]
		f.nextID++
		entries = append(entries, LoginLogEntry{
			ID: formatInt(f.nextID), IP: row.IP, Location: row.Location,
			UserAgent: row.UserAgent, Status: row.Status, Time: row.At,
		})
	}
	return logPage[LoginLogEntry]{Entries: entries, Total: int64(len(entries))}, nil
}

// QueryOperation 逆序返回。
func (f *fakeStore) QueryOperation(query operationLogListQuery) (logPage[OperationLogEntry], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	queryCopy := query
	f.lastOperationQuery = &queryCopy
	entries := []OperationLogEntry{}
	for i := len(f.operationRows) - 1; i >= 0; i-- {
		row := f.operationRows[i]
		f.nextID++
		entries = append(entries, OperationLogEntry{
			ID: formatInt(f.nextID), At: row.At, Category: row.Category, Action: row.Action,
			Target: row.Target, Summary: row.Summary, Result: row.Result,
			Method: row.Method, Path: row.Path, HTTPStatus: row.HTTPStatus,
		})
	}
	return logPage[OperationLogEntry]{Entries: entries, Total: int64(len(entries))}, nil
}

// Clear 删本类别行并返回统计。
func (f *fakeStore) Clear(category string) (logClearStats, error) {
	f.beginMaintenance()
	defer f.endMaintenance()
	f.mu.Lock()
	defer f.mu.Unlock()
	f.clearCalls = append(f.clearCalls, category)
	if f.clearErr != nil {
		return logClearStats{}, f.clearErr
	}
	stats := logClearStats{}
	switch category {
	case categoryRuntime:
		stats.RowCount = int64(len(f.runtimeRows))
		stats.TotalBytes = int64(len(f.runtimeRows)) * 1024
		if len(f.runtimeRows) > 0 {
			oldest := f.runtimeRows[0].At
			stats.OldestAt = &oldest
		}
		f.runtimeRows = nil
	case categoryOperation:
		stats.RowCount = int64(len(f.operationRows))
		stats.TotalBytes = int64(len(f.operationRows)) * 1024
		if len(f.operationRows) > 0 {
			oldest := f.operationRows[0].At
			stats.OldestAt = &oldest
		}
		f.operationRows = nil
	case categoryLogin:
		stats.RowCount = int64(len(f.loginRows))
		if len(f.loginRows) > 0 {
			oldest := f.loginRows[0].At
			stats.OldestAt = &oldest
		}
		f.loginRows = nil
	}
	return stats, nil
}

// Sweep canned 结果 + 可阻塞（互斥与合并测试用）。
func (f *fakeStore) Sweep(category string, now time.Time) logSweepResult {
	f.beginMaintenance()
	defer f.endMaintenance()
	f.mu.Lock()
	f.sweepCalls++
	f.mu.Unlock()
	if f.sweepBlock != nil {
		<-f.sweepBlock
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sweepResults[category]
}

// Storage 固定统计。
func (f *fakeStore) Storage(lastSweepAt *string, trimmedBySize bool) LogStorageStats {
	stats := f.storageFixture
	stats.LastSweepAt = lastSweepAt
	stats.TrimmedBySize = trimmedBySize
	return stats
}

// Counters 恒零。
func (f *fakeStore) Counters() (int, int) { return 0, 0 }

// Close 空操作。
func (f *fakeStore) Close() error { return nil }

// runtimeRowsOf 快照。
func (f *fakeStore) runtimeRowsOf() []runtimeInsert {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]runtimeInsert(nil), f.runtimeRows...)
}

// operationRowsOf 快照。
func (f *fakeStore) operationRowsOf() []operationInsert {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]operationInsert(nil), f.operationRows...)
}

// loginRowsOf 快照。
func (f *fakeStore) loginRowsOf() []loginInsert {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]loginInsert(nil), f.loginRows...)
}

// formatInt 整数转字符串。
func formatInt(v int64) string {
	return strconvFormatInt(float64(v))
}

// sinkService 采集 sink：把记录收进数组；可注入 panic 验证采集失败不影响业务。
type sinkService struct {
	mu          sync.Mutex
	operations  []seam.OperationRecord
	runtimes    []runtimeLine
	logins      []LoginRecord
	panicWrites bool
}

// runtimeLine 运行日志行。
type runtimeLine struct {
	level   string
	source  string
	message string
}

// Runtime 收集运行日志。
func (s *sinkService) Runtime(level, source, message string) {
	if s.panicWrites {
		panic("磁盘满")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.runtimes = append(s.runtimes, runtimeLine{level: level, source: source, message: message})
}

// RecordOperation 收集操作记录，并按 seam.Logs 契约落一条运行镜像
// （`操作：<action>（成功|失败）`）——镜像由服务实现承担，fake 复刻同一契约。
func (s *sinkService) RecordOperation(rec seam.OperationRecord) {
	if s.panicWrites {
		panic("磁盘满")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.operations = append(s.operations, rec)
	level := "info"
	outcome := "成功"
	if rec.Result != "success" {
		level = "warning"
		outcome = "失败"
	}
	s.runtimes = append(s.runtimes, runtimeLine{
		level: level, source: operationLogSource,
		message: fmt.Sprintf("操作：%s（%s）", rec.Action, outcome),
	})
}

// RecordLogin 收集登录记录。
func (s *sinkService) RecordLogin(input LoginRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logins = append(s.logins, input)
}

// operationsOf 快照。
func (s *sinkService) operationsOf() []seam.OperationRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]seam.OperationRecord(nil), s.operations...)
}

// runtimesOf 快照。
func (s *sinkService) runtimesOf() []runtimeLine {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]runtimeLine(nil), s.runtimes...)
}

// loginsOf 快照。
func (s *sinkService) loginsOf() []LoginRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]LoginRecord(nil), s.logins...)
}
