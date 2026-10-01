package logs

import (
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

// fixedClock 固定时钟（服务端时刻完全确定）。
func fixedClock(t time.Time) func() time.Time { return func() time.Time { return t } }

// OpenService：打开成功产出可用服务；父目录不可建时内部降级为不可用实现（logsHostDeps）。
func TestOpenServiceDegradation(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "data", "logs.sqlite")
	svc := OpenService(dbPath, fixedClock(time.Date(2026, 9, 23, 0, 0, 2, 0, time.UTC)))
	svc.Runtime("info", "server.lifecycle", "Elysian 服务已启动：http://127.0.0.1:48101")
	full := svc.(ServiceAPI)
	report, err := full.RuntimeLog(logListQuery{})
	if err != nil {
		t.Fatalf("打开成功的服务应可查询：%v", err)
	}
	// 容器内的真实分片目录可能残留历史分片（卷持久化），只断言本次写入在列。
	found := false
	for _, entry := range report.Entries {
		if entry.Source == "server.lifecycle" {
			found = true
		}
	}
	if !found {
		t.Errorf("启动运行日志未入库：%+v", report.Entries)
	}

	// 父路径被同名文件占据 → mkdir 失败 → 降级不可用（查询回「日志数据库不可用」）。
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("建占位文件失败：%v", err)
	}
	degraded := OpenService(filepath.Join(blocker, "data", "logs.sqlite"), nil)
	degradedFull := degraded.(ServiceAPI)
	if _, err := degradedFull.RuntimeLog(logListQuery{}); err == nil || err.Error() != unavailableMessage {
		t.Errorf("降级服务查询应回不可用：%v", err)
	}
	// 降级写入只计数、不上抛。
	degraded.Runtime("info", "s", "m")
	degraded.RecordOperation(seam.OperationRecord{Category: "logs", Action: "清空运行日志", Result: "success"})
}

// newTestService 服务 + 内存 store + 固定时钟。
func newTestService() (*Service, *fakeStore) {
	store := newFakeStore()
	svc := NewService(store, fixedClock(time.Date(2026, 9, 23, 0, 0, 2, 0, time.UTC)), nil)
	return svc, store
}

// log/recordOperation 列表倒序、字段齐全、storage 透传（logsService.test.ts ①）。
func TestServiceLogAndRecordOperation(t *testing.T) {
	svc, store := newTestService()
	svc.Log("info", "server.lifecycle", "Elysian 服务已启动：http://127.0.0.1:48101")
	status := 200
	method := "PUT"
	path := "/api/security/ssh/port"
	target := "sshd"
	summary := "端口 2222"
	svc.RecordOperation(seam.OperationRecord{
		Category: "security", Action: "修改 SSH 监听端口", Target: &target, Summary: &summary,
		Result: "success", Method: method, Path: path, HTTPStatus: &status,
	})

	report, err := svc.RuntimeLog(logListQuery{})
	if err != nil {
		t.Fatalf("runtimeLog 失败：%v", err)
	}
	// 倒序：镜像行（后写）在首，server.lifecycle 在次。
	if len(report.Entries) != 2 || report.Entries[1].Source != "server.lifecycle" {
		t.Errorf("运行日志倒序不符：%+v", report.Entries)
	}
	if report.Entries[1].At != "2026-09-23T00:00:02.000Z" {
		t.Errorf("at 应取服务端时钟：%s", report.Entries[1].At)
	}
	if report.SkippedLines != 0 || report.SkippedFiles != 0 {
		t.Errorf("skipped 恒 0：%+v", report)
	}
	// 运行日志镜像：操作：xxx（成功），level info、source logs.operation。
	mirror := report.Entries[0]
	if mirror.Level != "info" || mirror.Source != operationLogSource || mirror.Message != "操作：修改 SSH 监听端口（成功）" {
		t.Errorf("镜像行不符：%+v", mirror)
	}

	opReport, err := svc.OperationLog(operationLogListQuery{})
	if err != nil {
		t.Fatalf("operationLog 失败：%v", err)
	}
	if len(opReport.Entries) != 1 {
		t.Fatalf("操作日志条数：%d", len(opReport.Entries))
	}
	entry := opReport.Entries[0]
	if entry.Category != "security" || entry.Action != "修改 SSH 监听端口" ||
		entry.Target == nil || *entry.Target != "sshd" || entry.Result != "success" ||
		entry.Method == nil || *entry.Method != "PUT" || entry.HTTPStatus == nil || *entry.HTTPStatus != 200 {
		t.Errorf("操作日志字段不齐：%+v", entry)
	}
	_ = store
}

// 筛选下传 store（logsService.test.ts ②）。
func TestServiceFiltersPassThrough(t *testing.T) {
	svc, store := newTestService()
	query := operationLogListQuery{}
	query.HasQ = true
	query.Q = "error"
	query.HasLimit = true
	query.Limit = 5
	query.HasCategory = true
	query.Category = "containers"
	query.HasResult = true
	query.Result = "failure"
	if _, err := svc.OperationLog(query); err != nil {
		t.Fatalf("operationLog 失败：%v", err)
	}
	got := store.lastOperationQuery
	if got == nil || got.Q != "error" || got.Limit != 5 || got.Category != "containers" || got.Result != "failure" {
		t.Errorf("筛选未下传：%+v", got)
	}

	loginQuery := loginLogListQuery{}
	loginQuery.HasStatus = true
	loginQuery.Status = "failure"
	if _, err := svc.LoginLog(loginQuery); err != nil {
		t.Fatalf("loginLog 失败：%v", err)
	}
	if store.lastLoginQuery == nil {
		t.Fatalf("登录查询未下传")
	}
}

// 清空报告 + 运行/操作双留痕（logsService.test.ts ④，message 正则逐字锚定）。
func TestServiceClearLeavesTraces(t *testing.T) {
	svc, store := newTestService()
	svc.Log("info", "server.lifecycle", "a")
	svc.Log("info", "server.lifecycle", "b")
	inserted := 2

	report, err := svc.Clear(categoryRuntime)
	if err != nil {
		t.Fatalf("clear 失败：%v", err)
	}
	if report.Category != "runtime" || report.RowCount != int64(inserted) || report.TotalBytes <= 0 {
		t.Errorf("清空报告不符：%+v", report)
	}
	if report.ClearedAt != "2026-09-23T00:00:02.000Z" {
		t.Errorf("clearedAt 应取服务端时钟：%s", report.ClearedAt)
	}

	rows := store.runtimeRowsOf()
	if len(rows) != 1 {
		t.Fatalf("运行日志留痕应恰一条：%d", len(rows))
	}
	if rows[0].Level != "warning" || rows[0].Source != "logs.clear" {
		t.Errorf("留痕级别/来源不符：%+v", rows[0])
	}
	wantRegex := regexp.MustCompile(`^运行日志已清空：删除 2 条记录，释放 [\d.]+ (KB|MB|GB)$`)
	if !wantRegex.MatchString(rows[0].Message) {
		t.Errorf("留痕文案不符：%q", rows[0].Message)
	}

	ops := store.operationRowsOf()
	if len(ops) != 1 {
		t.Fatalf("操作日志留痕应恰一条：%d", len(ops))
	}
	if ops[0].Category != "logs" || ops[0].Action != "清空运行日志" || ops[0].Result != "success" ||
		ops[0].Target != nil || ops[0].Method != nil || ops[0].Path != nil || ops[0].HTTPStatus != nil {
		t.Errorf("操作留痕字段不符：%+v", ops[0])
	}

	// 连清两次等价：第二次 rowCount 正是第一次的留痕（=1）。
	second, err := svc.Clear(categoryRuntime)
	if err != nil {
		t.Fatalf("第二次 clear 失败：%v", err)
	}
	if second.RowCount != 1 {
		t.Errorf("第二次清空 rowCount = %d, want 1（第一次的留痕）", second.RowCount)
	}
}

// 清空失败不留痕（logsService.test.ts ⑤）。
func TestServiceClearFailureLeavesNoTrace(t *testing.T) {
	svc, store := newTestService()
	svc.Log("info", "server.lifecycle", "a")
	store.clearErr = errLogStoreUnavailable

	if _, err := svc.Clear(categoryRuntime); err == nil {
		t.Fatalf("clear 失败应上抛")
	}
	if rows := store.runtimeRowsOf(); len(rows) != 1 {
		t.Errorf("清空失败不得写留痕（只保留原 1 行）：%d", len(rows))
	}
	if ops := store.operationRowsOf(); len(ops) != 0 {
		t.Errorf("清空失败不得写操作留痕：%d", len(ops))
	}
}

// 清空只清本类别（logsService.test.ts ⑧）。
func TestServiceClearOnlyOwnCategory(t *testing.T) {
	svc, store := newTestService()
	svc.Log("info", "server.lifecycle", "runtime-row")
	status := 200
	svc.RecordOperation(seam.OperationRecord{
		Category: "logs", Action: "清空运行日志", Result: "success",
		Method: "POST", Path: "/api/logs/runtime/clear", HTTPStatus: &status,
	})

	if _, err := svc.Clear(categoryRuntime); err != nil {
		t.Fatalf("clear 失败：%v", err)
	}
	// operation 行仍在，随后 clear 后补的两条留痕来自 clear 本身。
	if len(store.runtimeRowsOf()) != 1 {
		t.Errorf("runtime 表应只剩 clear 留痕：%d", len(store.runtimeRowsOf()))
	}
	if len(store.operationRowsOf()) != 2 { // 原 1 行 + clear 的操作留痕 1 行
		t.Errorf("operation 表应有原行 + 留痕：%d", len(store.operationRowsOf()))
	}
}

// runSweep 更新 lastSweepAt、留痕文案逐字锚定（logsService.test.ts ⑨）。
func TestServiceRunSweepMessages(t *testing.T) {
	svc, store := newTestService()
	store.sweepResults[categoryRuntime] = logSweepResult{
		DeletedByAge: 1, DeletedBySize: 1, FreedBytes: 2048, TotalBytes: 512, TrimmedBySize: true,
	}
	result := svc.RunSweep(categoryRuntime, sweepReasonManual)
	if result.at != "2026-09-23T00:00:02.000Z" || result.deletedByAge != 1 || result.trimmedBySize != true {
		t.Errorf("sweep 结果不符：%+v", result)
	}

	report, err := svc.RuntimeLog(logListQuery{})
	if err != nil {
		t.Fatalf("runtimeLog 失败：%v", err)
	}
	if report.Storage.LastSweepAt == nil || *report.Storage.LastSweepAt != "2026-09-23T00:00:02.000Z" {
		t.Errorf("lastSweepAt 未更新：%+v", report.Storage)
	}
	if !report.Storage.TrimmedBySize {
		t.Errorf("trimmedBySize 未更新")
	}

	rows := store.runtimeRowsOf()
	if len(rows) != 1 {
		t.Fatalf("巡检摘要应恰一条：%d", len(rows))
	}
	if rows[0].Level != "warning" || rows[0].Source != "logs.retention" {
		t.Errorf("摘要级别/来源不符：%+v", rows[0])
	}
	if rows[0].Message != "保留巡检完成：删除 2、释放 2.00 KB" {
		t.Errorf("摘要文案不符：%q", rows[0].Message)
	}
	for _, row := range rows {
		if regexp.MustCompile(`压缩`).MatchString(row.Message) {
			t.Errorf("摘要不得提「压缩」：%q", row.Message)
		}
	}

	// failed>0 追加失败行；超预算追加上限行（level 均 warning）。
	store2 := newFakeStore()
	store2.sweepResults[categoryOperation] = logSweepResult{
		Failed: 1, TotalBytes: 128 * 1024 * 1024,
	}
	svc2 := NewService(store2, fixedClock(time.Date(2026, 9, 23, 0, 0, 2, 0, time.UTC)), nil)
	svc2.RunSweep(categoryOperation, sweepReasonManual)
	messages := []string{}
	for _, row := range store2.runtimeRowsOf() {
		messages = append(messages, row.Message)
	}
	if len(messages) != 3 {
		t.Fatalf("failed>0 且超预算应写三行摘要：%v", messages)
	}
	if !regexp.MustCompile(`^保留巡检完成：删除 0、释放 0\.00 KB$`).MatchString(messages[0]) {
		t.Errorf("零删除且 failed>0 应为 warning 完成行：%q", messages[0])
	}
	if !regexp.MustCompile(`^保留巡检有 1 项失败（详见服务端 stderr 与目录权限）$`).MatchString(messages[1]) {
		t.Errorf("失败行文案不符：%q", messages[1])
	}
	if !regexp.MustCompile(`^操作日志仍超出总量上限：当前 128\.00 MB、上限 64\.00 MB（只剩活动分片或静默窗口内的文件，已停止删除）$`).MatchString(messages[2]) {
		t.Errorf("超预算行文案不符：%q", messages[2])
	}
}

// 定时器每类别注册一次、间隔 5 分钟（logsService.test.ts ⑩）。
func TestServiceTimerRegisteredOncePerCategory(t *testing.T) {
	store := newFakeStore()
	var mu sync.Mutex
	registrations := []struct {
		category string
		interval time.Duration
	}{}
	svc := NewService(store, fixedClock(time.Date(2026, 9, 23, 0, 0, 2, 0, time.UTC)), func(onTick func(), interval time.Duration) {
		mu.Lock()
		defer mu.Unlock()
		registrations = append(registrations, struct {
			category string
			interval time.Duration
		}{category: "captured-at-call", interval: interval})
		// 不真正触发 tick。
	})

	svc.RunSweep(categoryRuntime, sweepReasonManual)
	svc.RunSweep(categoryRuntime, sweepReasonManual)
	svc.RunSweep(categoryOperation, sweepReasonManual)

	mu.Lock()
	defer mu.Unlock()
	if len(registrations) != 2 {
		t.Errorf("定时器注册次数 = %d, want 2（runtime/operation 各一次）", len(registrations))
	}
	for _, reg := range registrations {
		if reg.interval != logSweepInterval {
			t.Errorf("定时器间隔 = %v, want %v", reg.interval, logSweepInterval)
		}
	}
	// clear 的 after-clear 不注册定时器。
	if _, err := svc.Clear(categoryRuntime); err != nil {
		t.Fatalf("clear 失败：%v", err)
	}
	if len(registrations) != 2 {
		t.Errorf("after-clear 不应注册定时器：%d", len(registrations))
	}
}

// 并发 runSweep 同类别合并同一结果；clear 与 sweep 互斥（logsService.test.ts ⑪⑭）。
func TestServiceSweepMergeAndClearMutex(t *testing.T) {
	store := newFakeStore()
	store.sweepResults[categoryRuntime] = logSweepResult{DeletedByAge: 3, FreedBytes: 4096}
	gate := make(chan struct{})
	store.sweepBlock = gate
	svc := NewService(store, fixedClock(time.Date(2026, 9, 23, 0, 0, 2, 0, time.UTC)), func(onTick func(), interval time.Duration) {})

	results := make([]sweepResult, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); results[0] = svc.RunSweep(categoryRuntime, sweepReasonManual) }()
	// 等首位进入 store.Sweep（阻塞在 gate 上）。
	for {
		store.mu.Lock()
		calls := store.sweepCalls
		store.mu.Unlock()
		if calls == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	go func() { defer wg.Done(); results[1] = svc.RunSweep(categoryRuntime, sweepReasonManual) }()
	// 留出调度窗口：第二个 RunSweep 应命中在途 pending 合并到同一结果。
	time.Sleep(50 * time.Millisecond)

	// 在 sweep 在途时并发 clear：必须等 sweep 结束（互斥），不得重叠进入维护操作。
	clearDone := make(chan error, 1)
	go func() { _, err := svc.Clear(categoryRuntime); clearDone <- err }()
	time.Sleep(20 * time.Millisecond)

	store.mu.Lock()
	callsWhileSweeping := store.sweepCalls
	store.mu.Unlock()
	if callsWhileSweeping != 1 {
		t.Errorf("在途 sweep 期间不应有第二个 store.Sweep：%d", callsWhileSweeping)
	}

	close(gate)
	wg.Wait()
	if err := <-clearDone; err != nil {
		t.Fatalf("并发 clear 失败：%v", err)
	}

	if results[0].deletedByAge != 3 || results[1].deletedByAge != 3 || results[0].at != results[1].at {
		t.Errorf("并发同类别应合并同一结果：%+v / %+v", results[0], results[1])
	}
	store.mu.Lock()
	totalSweeps := store.sweepCalls
	store.mu.Unlock()
	// 手动巡检（合并为 1 次）+ clear 内部 after-clear 巡检 1 次。
	if totalSweeps != 2 {
		t.Errorf("store.Sweep 调用次数 = %d, want 2", totalSweeps)
	}
	if store.overlapMaintenance.Load() {
		t.Errorf("clear 与 sweep 出现重叠（互斥失效）")
	}
}

// after-clear 不重复写摘要（logsService.test.ts ⑫）。
func TestServiceAfterClearWritesNoSweepSummary(t *testing.T) {
	svc, store := newTestService()
	store.sweepResults[categoryRuntime] = logSweepResult{DeletedByAge: 0, DeletedBySize: 0}
	if _, err := svc.Clear(categoryRuntime); err != nil {
		t.Fatalf("clear 失败：%v", err)
	}
	for _, row := range store.runtimeRowsOf() {
		if row.Source == "logs.retention" {
			t.Errorf("after-clear 不得写巡检摘要行：%+v", row)
		}
	}
}

// 登录日志：ip 归一、归属地推导、UA 单行化、空 UA → 未知（logsService.test.ts ⑬）。
func TestServiceRecordLogin(t *testing.T) {
	svc, store := newTestService()
	svc.RecordLogin(LoginRecord{IP: "not-an-ip", UserAgent: "bad\nagent", Status: "failure"})
	svc.RecordLogin(LoginRecord{IP: "10.0.0.8", UserAgent: "", Status: "success"})

	rows := store.loginRowsOf()
	if len(rows) != 2 {
		t.Fatalf("登录日志条数：%d", len(rows))
	}
	first := rows[0]
	if first.IP != unknownAddress || first.Location != "未知" || first.UserAgent != "bad agent" || first.Status != "failure" {
		t.Errorf("首条登录日志不符：%+v", first)
	}
	second := rows[1]
	if second.IP != "10.0.0.8" || second.Location != "内网" || second.UserAgent != "未知" {
		t.Errorf("次条登录日志不符：%+v", second)
	}
	if first.At != "2026-09-23T00:00:02.000Z" || second.At != "2026-09-23T00:00:02.000Z" {
		t.Errorf("at 应取服务端时钟")
	}

	report, err := svc.LoginLog(loginLogListQuery{})
	if err != nil {
		t.Fatalf("loginLog 失败：%v", err)
	}
	// 倒序：第二次写入（10.0.0.8）在首。
	if len(report.Entries) != 2 || report.Entries[0].IP != "10.0.0.8" || report.Entries[1].IP != unknownAddress {
		t.Errorf("登录日志倒序不符：%+v", report.Entries)
	}
}
