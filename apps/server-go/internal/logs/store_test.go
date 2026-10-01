package logs

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// openTestStore 测试库：临时目录 + 可选策略覆盖。
func openTestStore(t *testing.T, policies map[string]logRetentionPolicy) *sqliteStore {
	t.Helper()
	store, err := openLogStore(filepath.Join(t.TempDir(), "logs.sqlite"), policies)
	if err != nil {
		t.Fatalf("打开测试库失败：%v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

// insertOperationRow 测试便捷写入（无 key、固定时刻）。
func insertOperationRow(t *testing.T, store *sqliteStore, at, action string, category, result, target string) {
	t.Helper()
	var targetPtr *string
	if target != "" {
		targetPtr = &target
	}
	store.InsertOperation(operationInsert{
		At: at, Category: category, Action: action, Target: targetPtr,
		Summary: action, Result: result,
	})
}

// 操作日志按 category+result 筛选、关键字忽略大小写且 %/_ 字面匹配、id 为纯数字串
// （logStore.bun.test.ts ① 的对应用例）。
func TestQueryOperationFilterAndKeyword(t *testing.T) {
	store := openTestStore(t, nil)
	insertOperationRow(t, store, "2026-09-23T00:00:01.000Z", "新增端口规则 A", "security", "success", "80/tcp 放行")
	insertOperationRow(t, store, "2026-09-23T00:00:02.000Z", "100%_ok", "containers", "failure", "100%_ok")
	insertOperationRow(t, store, "2026-09-23T00:00:03.000Z", "命中 100%_ok 的行", "containers", "success", "")

	page, err := store.QueryOperation(operationLogListQuery{})
	if err != nil {
		t.Fatalf("查询失败：%v", err)
	}
	if len(page.Entries) != 3 || page.Total != 3 {
		t.Fatalf("全量 = %d/%d", len(page.Entries), page.Total)
	}
	// 时间倒序 + id 纯数字串。
	if page.Entries[0].ID != "3" || page.Entries[1].ID != "2" || page.Entries[2].ID != "1" {
		t.Errorf("倒序或 id 形状不符：%v", page.Entries)
	}
	if page.Entries[0].At != "2026-09-23T00:00:03.000Z" {
		t.Errorf("at 不符：%s", page.Entries[0].At)
	}

	// category + result 筛选。
	query := operationLogListQuery{}
	query.HasCategory = true
	query.Category = "containers"
	query.HasResult = true
	query.Result = "success"
	page, err = store.QueryOperation(query)
	if err != nil || len(page.Entries) != 1 || page.Entries[0].Action != "命中 100%_ok 的行" {
		t.Errorf("category+result 筛选不符：%+v %v", page, err)
	}

	// 关键字 %/_ 字面匹配且大小写不敏感：q=100%_OK 命中 `100%_ok`。
	query = operationLogListQuery{}
	query.HasQ = true
	query.Q = "100%_OK"
	page, err = store.QueryOperation(query)
	if err != nil {
		t.Fatalf("关键字查询失败：%v", err)
	}
	if len(page.Entries) != 2 {
		t.Fatalf("q=100%%_OK 应命中两行（action 与 target），得 %d", len(page.Entries))
	}
	for _, entry := range page.Entries {
		inAction := strings.Contains(entry.Action, "100%_ok")
		inTarget := entry.Target != nil && strings.Contains(*entry.Target, "100%_ok")
		if !inAction && !inTarget {
			t.Errorf("命中行不含关键字：%+v", entry)
		}
	}

	// q=100%（裸 %）不匹配任意串以外的行——只命中含字面 `100%` 的行。
	query.Q = "100%"
	page, _ = store.QueryOperation(query)
	if len(page.Entries) != 2 {
		t.Errorf("q=100%% 应命中两行，得 %d", len(page.Entries))
	}
}

// limit=1 时 truncated=true；before/beforeId 翻页取更旧行；limit=5000 钳到 1000。
func TestQueryPaginationAndClamp(t *testing.T) {
	store := openTestStore(t, nil)
	for i := 1; i <= 5; i++ {
		store.InsertRuntime(runtimeInsert{
			At: fmt.Sprintf("2026-09-23T00:00:0%d.000Z", i), Level: "info",
			Source: "server.lifecycle", Message: fmt.Sprintf("m%d", i),
		})
	}
	query := logListQuery{}
	query.HasLimit = true
	query.Limit = 1
	page, err := store.QueryRuntime(query)
	if err != nil {
		t.Fatalf("查询失败：%v", err)
	}
	if len(page.Entries) != 1 || !page.Truncated || page.Total != 5 {
		t.Errorf("limit=1：entries=%d truncated=%v total=%d", len(page.Entries), page.Truncated, page.Total)
	}
	if page.Entries[0].Message != "m5" {
		t.Errorf("最新一条应在首位：%s", page.Entries[0].Message)
	}

	// 游标：before=m5 的时刻、beforeId=5 → 取更旧的 4 行。
	cursor := logListQuery{}
	cursor.HasCursor = true
	cursor.Before = "2026-09-23T00:00:05.000Z"
	cursor.BeforeID = 5
	cursor.HasLimit = true
	cursor.Limit = 2
	page, err = store.QueryRuntime(cursor)
	if err != nil {
		t.Fatalf("游标查询失败：%v", err)
	}
	if len(page.Entries) != 2 || page.Entries[0].Message != "m4" || page.Entries[1].Message != "m3" {
		t.Errorf("游标应取更旧行：%v", page.Entries)
	}
	if page.Total != 5 {
		t.Errorf("total 只含筛选不含游标：%d", page.Total)
	}
	if !page.Truncated {
		t.Errorf("游标后剩余 4 行 > 返回 2 行，truncated 应为 true")
	}

	// 同刻不同 id：at 相等时按 id 更小取。
	sameTime := logListQuery{}
	sameTime.HasCursor = true
	sameTime.Before = "2026-09-23T00:00:03.000Z"
	sameTime.BeforeID = 3
	page, _ = store.QueryRuntime(sameTime)
	if len(page.Entries) != 2 || page.Entries[0].Message != "m2" {
		t.Errorf("同刻游标应按 id 降序：%v", page.Entries)
	}

	// limit=5000 钳到 1000：插入 1001 行，返回恰 1000 行且 truncated。
	for i := 0; i < 1001; i++ {
		store.InsertRuntime(runtimeInsert{
			At: "2026-09-22T00:00:00.000Z", Level: "debug", Source: "s", Message: fmt.Sprintf("bulk%d", i),
		})
	}
	clamped := logListQuery{}
	clamped.HasLimit = true
	clamped.Limit = 5000
	page, err = store.QueryRuntime(clamped)
	if err != nil {
		t.Fatalf("钳制查询失败：%v", err)
	}
	if len(page.Entries) != 1000 || !page.Truncated {
		t.Errorf("limit=5000 应钳到 1000：entries=%d truncated=%v", len(page.Entries), page.Truncated)
	}
}

// runtime 关键字落 source/message；login 关键字落 ip/location/user_agent、status 筛选
// 与 time 字段映射（logStore.bun.test.ts ③）。
func TestQueryRuntimeAndLoginKeywords(t *testing.T) {
	store := openTestStore(t, nil)
	store.InsertRuntime(runtimeInsert{At: "2026-09-23T00:00:01.000Z", Level: "info", Source: "server.lifecycle", Message: "面板启动"})
	store.InsertRuntime(runtimeInsert{At: "2026-09-23T00:00:02.000Z", Level: "error", Source: "other", Message: "ERROR boom"})

	query := logListQuery{}
	query.HasQ = true
	query.Q = "lifecycle"
	page, _ := store.QueryRuntime(query)
	if len(page.Entries) != 1 || page.Entries[0].Source != "server.lifecycle" {
		t.Errorf("source 关键字未命中：%+v", page.Entries)
	}
	query.Q = "boom"
	page, _ = store.QueryRuntime(query)
	if len(page.Entries) != 1 || page.Entries[0].Message != "ERROR boom" {
		t.Errorf("message 关键字未命中：%+v", page.Entries)
	}
	query.Q = "BOOM"
	page, _ = store.QueryRuntime(query)
	if len(page.Entries) != 1 {
		t.Errorf("关键字应大小写不敏感：%+v", page.Entries)
	}

	store.InsertLogin(loginInsert{At: "2026-09-23T00:00:01.000Z", IP: "10.0.0.8", Location: "内网", UserAgent: "Mozilla/5.0", Status: "success"})
	store.InsertLogin(loginInsert{At: "2026-09-23T00:00:02.000Z", IP: "127.0.0.1", Location: "本机", UserAgent: "curl/8", Status: "failure"})

	loginQuery := loginLogListQuery{}
	loginQuery.HasQ = true
	loginQuery.Q = "mozilla"
	loginPage, _ := store.QueryLogin(loginQuery)
	if len(loginPage.Entries) != 1 || loginPage.Entries[0].IP != "10.0.0.8" {
		t.Errorf("user_agent 关键字未命中：%+v", loginPage.Entries)
	}
	loginQuery.Q = "内网"
	loginPage, _ = store.QueryLogin(loginQuery)
	if len(loginPage.Entries) != 1 {
		t.Errorf("location 关键字未命中：%+v", loginPage.Entries)
	}
	loginQuery.Q = "10.0.0.8"
	loginPage, _ = store.QueryLogin(loginQuery)
	if len(loginPage.Entries) != 1 {
		t.Errorf("ip 关键字未命中：%+v", loginPage.Entries)
	}

	loginQuery = loginLogListQuery{}
	loginQuery.HasQ = false
	loginQuery.HasStatus = true
	loginQuery.Status = "failure"
	loginPage, _ = store.QueryLogin(loginQuery)
	if len(loginPage.Entries) != 1 || loginPage.Entries[0].Status != "failure" {
		t.Errorf("status 筛选不符：%+v", loginPage.Entries)
	}
	// time 字段映射自 at 列（不是 at）。
	if loginPage.Entries[0].Time != "2026-09-23T00:00:02.000Z" {
		t.Errorf("time 映射不符：%s", loginPage.Entries[0].Time)
	}
}

// bytes 列记账：与 TS JSON.stringify 固定键序的字节数一致（含中文 3 字节/字）。
func TestRecordBytesAccounting(t *testing.T) {
	store := openTestStore(t, nil)
	at := "2026-09-23T00:00:02.000Z"
	store.InsertRuntime(runtimeInsert{At: at, Level: "info", Source: "server.lifecycle", Message: "启动"})
	expected := len(`{"at":"2026-09-23T00:00:02.000Z","level":"info","source":"server.lifecycle","message":"启动"}`)
	var bytes int
	if err := store.db.QueryRow("SELECT bytes FROM runtime_logs").Scan(&bytes); err != nil {
		t.Fatalf("读取 bytes 失败：%v", err)
	}
	if bytes != expected {
		t.Errorf("runtime bytes = %d, want %d", bytes, expected)
	}

	method := "PUT"
	path := "/api/security/ssh/port"
	target := "sshd"
	store.InsertOperation(operationInsert{
		At: at, Category: "security", Action: "修改 SSH 监听端口", Target: &target,
		Summary: "端口 2222", Result: "success", Method: &method, Path: &path, HTTPStatus: nil,
	})
	expected = len(`{"at":"2026-09-23T00:00:02.000Z","category":"security","action":"修改 SSH 监听端口","target":"sshd","result":"success","httpStatus":null,"method":"PUT","path":"/api/security/ssh/port","summary":"端口 2222"}`)
	if err := store.db.QueryRow("SELECT bytes FROM operation_logs").Scan(&bytes); err != nil {
		t.Fatalf("读取 bytes 失败：%v", err)
	}
	if bytes != expected {
		t.Errorf("operation bytes = %d, want %d", bytes, expected)
	}
}

// 超长 message 截断带 `…（已截断）` 不计 dropped（logStore.bun.test.ts ②）；
// 64 KiB 硬闸的判据在导入路径测试覆盖（服务路径被字段上限压住，构造不出超限单条）。
func TestOversizeAndTruncation(t *testing.T) {
	store := openTestStore(t, nil)
	long := strings.Repeat("x", 100) + strings.Repeat("好", 20000) // 净化后 60100 字符 > 4096 → 截断
	store.InsertRuntime(runtimeInsert{At: "2026-09-23T00:00:02.000Z", Level: "info", Source: "s", Message: long})
	page, _ := store.QueryRuntime(logListQuery{})
	if len(page.Entries) != 1 {
		t.Fatalf("超长 message 应截断入库而非丢弃：%d", len(page.Entries))
	}
	message := page.Entries[0].Message
	if jsLength(message) != logMessageMaxLength || !strings.HasSuffix(message, logTruncationMarker) {
		t.Errorf("截断不符：jsLength=%d suffix=%v", jsLength(message), strings.HasSuffix(message, logTruncationMarker))
	}
	dropped, failed := store.Counters()
	if dropped != 0 || failed != 0 {
		t.Errorf("截断不应计入 dropped/failed：%d/%d", dropped, failed)
	}
	if !isRecordOversize(strings.Repeat("x", logRecordMaxBytes+1)) {
		t.Errorf("超限判据失效")
	}
}

// sweep 按龄删除 + 超预算从最旧删（logStore.bun.test.ts ⑤）。
func TestSweepByAgeAndSize(t *testing.T) {
	store := openTestStore(t, map[string]logRetentionPolicy{
		categoryRuntime: {retentionDays: 7, maxTotalBytes: 1},
	})
	store.InsertRuntime(runtimeInsert{At: "2026-09-01T00:00:00.000Z", Level: "info", Source: "old", Message: "旧记录"})
	store.InsertRuntime(runtimeInsert{At: "2026-09-23T00:00:00.000Z", Level: "info", Source: "new", Message: "新记录"})

	now := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)
	result := store.Sweep(categoryRuntime, now)
	// 按龄：9 月 1 日 < now-7d（9 月 16 日）→ 删 1；按量上限 1 字节 → 剩余全删。
	if result.DeletedByAge != 1 {
		t.Errorf("按龄删除 = %d, want 1", result.DeletedByAge)
	}
	if result.DeletedBySize != 1 || !result.TrimmedBySize {
		t.Errorf("按量删除 = %d trimmed=%v, want 1/true", result.DeletedBySize, result.TrimmedBySize)
	}
	if result.TotalBytes != 0 {
		t.Errorf("totalBytes = %d, want 0", result.TotalBytes)
	}
	page, _ := store.QueryRuntime(logListQuery{})
	if len(page.Entries) != 0 {
		t.Errorf("应删光：%d", len(page.Entries))
	}

	// 未超龄超量的类别不动。
	store.InsertRuntime(runtimeInsert{At: "2026-09-23T00:00:00.000Z", Level: "info", Source: "keep", Message: "留"})
	result = store.Sweep(categoryRuntime, now)
	// maxTotalBytes=1 仍超量：从最旧删到满足（删光）。
	if result.DeletedBySize != 1 || result.TotalBytes != 0 {
		t.Errorf("超预算未从最旧删：%+v", result)
	}
}

// clear 只删本类别并返回 rowCount/totalBytes/oldestAt（logStore.bun.test.ts ⑥）。
func TestClearOwnCategoryOnly(t *testing.T) {
	store := openTestStore(t, nil)
	store.InsertRuntime(runtimeInsert{At: "2026-09-22T00:00:00.000Z", Level: "info", Source: "s", Message: "a"})
	store.InsertRuntime(runtimeInsert{At: "2026-09-23T00:00:00.000Z", Level: "info", Source: "s", Message: "b"})
	insertOperationRow(t, store, "2026-09-23T00:00:00.000Z", "动作", "logs", "success", "")

	stats, err := store.Clear(categoryRuntime)
	if err != nil {
		t.Fatalf("clear 失败：%v", err)
	}
	if stats.RowCount != 2 || stats.TotalBytes <= 0 {
		t.Errorf("runtime clear 统计不符：%+v", stats)
	}
	if stats.OldestAt == nil || *stats.OldestAt != "2026-09-22T00:00:00.000Z" {
		t.Errorf("oldestAt 不符：%v", stats.OldestAt)
	}
	runtimePage, _ := store.QueryRuntime(logListQuery{})
	operationPage, _ := store.QueryOperation(operationLogListQuery{})
	if len(runtimePage.Entries) != 0 || len(operationPage.Entries) != 1 {
		t.Errorf("clear 只应清本类别：runtime=%d operation=%d", len(runtimePage.Entries), len(operationPage.Entries))
	}

	stats, err = store.Clear(categoryRuntime)
	if err != nil || stats.RowCount != 0 || stats.OldestAt != nil {
		t.Errorf("空表 clear 应 rowCount=0/oldestAt=nil：%+v %v", stats, err)
	}
}

// 不可用 store：写入计 failedWrites、查询/清空抛「日志数据库不可用」（⑦）。
func TestUnavailableLogStore(t *testing.T) {
	store := newUnavailableLogStore()
	store.InsertRuntime(runtimeInsert{})
	store.InsertLogin(loginInsert{})
	store.InsertOperation(operationInsert{})
	if _, failed := store.Counters(); failed != 3 {
		t.Errorf("failedWrites = %d, want 3", failed)
	}
	if _, err := store.QueryRuntime(logListQuery{}); err == nil || err.Error() != unavailableMessage {
		t.Errorf("QueryRuntime 应抛 %q：%v", unavailableMessage, err)
	}
	if _, err := store.QueryLogin(loginLogListQuery{}); err == nil || err.Error() != unavailableMessage {
		t.Errorf("QueryLogin 应抛不可用")
	}
	if _, err := store.QueryOperation(operationLogListQuery{}); err == nil || err.Error() != unavailableMessage {
		t.Errorf("QueryOperation 应抛不可用")
	}
	if _, err := store.Clear(categoryRuntime); err == nil || err.Error() != unavailableMessage {
		t.Errorf("Clear 应抛不可用")
	}
	if _, _, err := store.ImportFile(categoryRuntime, nil); err == nil || err.Error() != unavailableMessage {
		t.Errorf("ImportFile 应抛不可用")
	}
	if result := store.Sweep(categoryRuntime, time.Now()); result.Failed != 1 {
		t.Errorf("Sweep 应回 failed:1：%+v", result)
	}
	stats := store.Storage(nil, true)
	if stats.FailedWrites != 3 || stats.TotalBytes != 0 || !stats.TrimmedBySize || stats.LastSweepAt != nil {
		t.Errorf("Storage 透传不符：%+v", stats)
	}
}

// storage 不计登录字节、rowCount 为两表之和、oldestAt 取两表 MIN、透传巡检字段（⑧）。
func TestStorageAggregates(t *testing.T) {
	store := openTestStore(t, nil)
	store.InsertRuntime(runtimeInsert{At: "2026-09-22T00:00:00.000Z", Level: "info", Source: "s", Message: "a"})
	insertOperationRow(t, store, "2026-09-21T00:00:00.000Z", "动作", "logs", "success", "")
	store.InsertLogin(loginInsert{At: "2026-09-20T00:00:00.000Z", IP: "127.0.0.1", Location: "本机", UserAgent: "UA", Status: "success"})

	lastSweep := "2026-09-23T00:00:00.000Z"
	stats := store.Storage(&lastSweep, true)
	if stats.RowCount != 2 || stats.RuntimeRowCount != 1 || stats.OperationRowCount != 1 {
		t.Errorf("rowCount 聚合不符：%+v", stats)
	}
	if stats.TotalBytes != stats.RuntimeBytes+stats.OperationBytes || stats.RuntimeBytes <= 0 || stats.OperationBytes <= 0 {
		t.Errorf("字节聚合不符：%+v", stats)
	}
	if stats.OldestAt == nil || *stats.OldestAt != "2026-09-21T00:00:00.000Z" {
		t.Errorf("oldestAt 应取两表较早者：%v（登录日志的最旧 9-20 不计入）", stats.OldestAt)
	}
	if stats.LastSweepAt == nil || *stats.LastSweepAt != lastSweep || !stats.TrimmedBySize {
		t.Errorf("巡检字段透传不符：%+v", stats)
	}
}

// 同 sourceKey 只留第一行（导入去重，经 ImportFile 驱动）。inserted 计「尝试行数」
// （TS 同口径：OR IGNORE 静默跳过也计数），去重事实由 UNIQUE 索引与查询行数承担。
func TestSourceKeyDedup(t *testing.T) {
	store := openTestStore(t, nil)
	line := `{"at":"2026-09-23T00:00:01.000Z","seq":1,"level":"info","source":"s","message":"first"}`
	inserted, skipped, err := store.ImportFile(categoryRuntime, []string{line, line, line})
	if err != nil || inserted != 3 || skipped != 0 {
		t.Fatalf("重复行尝试计数：inserted=%d skipped=%d err=%v", inserted, skipped, err)
	}
	page, _ := store.QueryRuntime(logListQuery{})
	if len(page.Entries) != 1 || page.Entries[0].Message != "first" {
		t.Errorf("去重不符：%+v", page.Entries)
	}

	// 行内空白不同即不同 key（sha256 是「整行原文」）。
	lineSpaced := `{"at":"2026-09-23T00:00:01.000Z","seq":1,"level":"info","source":"s","message":"first" }`
	inserted, _, err = store.ImportFile(categoryRuntime, []string{lineSpaced})
	if err != nil || inserted != 1 {
		t.Errorf("不同原文应各留一行：inserted=%d err=%v", inserted, err)
	}
	page, _ = store.QueryRuntime(logListQuery{})
	if len(page.Entries) != 2 {
		t.Errorf("应有 2 行：%d", len(page.Entries))
	}
}
