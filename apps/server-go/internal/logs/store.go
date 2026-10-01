package logs

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite" // 驱动注册：logs.sqlite 三表（纯 Go，无 CGO）

	"elysian/server/internal/shared"
)

/*
 * bun:sqlite 实现的 Go 等价物（logStore.ts）：三表 schema、写入去重、分页查询、清空、
 * 按龄/按量巡检、全库存储统计。
 *
 * 并发模型（盘点风险 5）：TS 侧同步单连接串行；Go 侧 SetMaxOpenConns(1) + 互斥锁，
 * 不启用 WAL（与存量文件与锁语义一致，go-plan D3）。
 */

// logStore 存储接口（真实 sqlite / 不可用回落共用）。
type logStore interface {
	InsertRuntime(input runtimeInsert)
	InsertLogin(input loginInsert)
	InsertOperation(input operationInsert)
	// ImportFile 单事务导入整份分片：坏行跳过计数，单行超限即整份回滚（返回错误）。
	ImportFile(category string, lines []string) (inserted, skipped int, err error)
	QueryRuntime(query logListQuery) (logPage[RuntimeLogEntry], error)
	QueryLogin(query loginLogListQuery) (logPage[LoginLogEntry], error)
	QueryOperation(query operationLogListQuery) (logPage[OperationLogEntry], error)
	Clear(category string) (logClearStats, error)
	Sweep(category string, now time.Time) logSweepResult
	Storage(lastSweepAt *string, trimmedBySize bool) LogStorageStats
	Counters() (droppedRecords int, failedWrites int)
	Close() error
}

// runtimeInsert 运行日志写入入参；SourceKey 非空走 INSERT OR IGNORE 去重（仅导入使用）。
type runtimeInsert struct {
	At        string
	Level     string
	Source    string
	Message   string
	SourceKey *string
}

// loginInsert 登录日志写入入参。
type loginInsert struct {
	At        string
	IP        string
	Location  string
	UserAgent string
	Status    string
	SourceKey *string
}

// operationInsert 操作日志写入入参。
type operationInsert struct {
	At         string
	Category   string
	Action     string
	Target     *string
	Summary    string
	Result     string
	Method     *string
	Path       *string
	HTTPStatus *int64
	SourceKey  *string
}

// logPage 一页查询结果。
type logPage[T any] struct {
	Entries   []T
	Total     int64
	Truncated bool
}

// logClearStats clear 在事务内取到的删除事实。
type logClearStats struct {
	RowCount   int64
	TotalBytes int64
	OldestAt   *string
}

// logSweepResult sweep 的原始结果（service 层再补 at 与留痕）。
type logSweepResult struct {
	DeletedByAge  int
	DeletedBySize int
	FreedBytes    int64
	TotalBytes    int64
	TrimmedBySize bool
	Failed        int
}

// emptySweep 空结果（failed 可带 1）。
func emptySweep(failed int) logSweepResult {
	return logSweepResult{Failed: failed}
}

// tableOf 巡检类别 → 表名。
var tableOf = map[string]string{
	categoryRuntime:   "runtime_logs",
	categoryOperation: "operation_logs",
	categoryLogin:     "login_logs",
}

// dayDuration 保留窗口的一天。
const dayDuration = 24 * time.Hour

// schemaSQL 三表 schema（与 TS 版一字不差，CREATE TABLE IF NOT EXISTS 保证可打开存量库）。
const schemaSQL = `
CREATE TABLE IF NOT EXISTS runtime_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  source_key TEXT UNIQUE,
  bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runtime_logs_at ON runtime_logs (at);

CREATE TABLE IF NOT EXISTS login_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  ip TEXT NOT NULL,
  location TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  status TEXT NOT NULL,
  source_key TEXT UNIQUE,
  bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_logs_at ON login_logs (at);
CREATE INDEX IF NOT EXISTS login_logs_status_at ON login_logs (status, at);

CREATE TABLE IF NOT EXISTS operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  summary TEXT NOT NULL,
  result TEXT NOT NULL,
  method TEXT,
  path TEXT,
  http_status INTEGER,
  source_key TEXT UNIQUE,
  bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS operation_logs_at ON operation_logs (at);
CREATE INDEX IF NOT EXISTS operation_logs_category_result_at ON operation_logs (category, result, at);
`

// cursorSQL 游标过滤：严格更早（at 更小，或同刻 id 更小）。
const cursorSQL = "(? IS NULL OR at < ? OR (at = ? AND id < ?))"

// runtimeRecordJSON / loginRecordJSON / operationRecordJSON bytes 列记账的固定键序
// （对齐 TS JSON.stringify 的字面量插入序；经 shared.MarshalJSON 不转义 <>&）。
type runtimeRecordJSON struct {
	At      string `json:"at"`
	Level   string `json:"level"`
	Source  string `json:"source"`
	Message string `json:"message"`
}

type loginRecordJSON struct {
	At        string `json:"at"`
	IP        string `json:"ip"`
	Location  string `json:"location"`
	UserAgent string `json:"userAgent"`
	Status    string `json:"status"`
}

type operationRecordJSON struct {
	At         string  `json:"at"`
	Category   string  `json:"category"`
	Action     string  `json:"action"`
	Target     *string `json:"target"`
	Result     string  `json:"result"`
	HTTPStatus *int64  `json:"httpStatus"`
	Method     *string `json:"method"`
	Path       *string `json:"path"`
	Summary    string  `json:"summary"`
}

// recordBytes utf8ByteLength(JSON.stringify(v))。
func recordBytes(v any) int {
	data, err := shared.MarshalJSON(v)
	if err != nil {
		return 0
	}
	return len(data)
}

// sqliteStore modernc.org/sqlite 实现。
type sqliteStore struct {
	db             *sql.DB
	mu             sync.Mutex
	policies       map[string]logRetentionPolicy
	droppedRecords int
	failedWrites   int
}

// openLogStore 打开（必要时创建）logs.sqlite 并确保 schema；父目录 0700。
func openLogStore(path string, policies map[string]logRetentionPolicy) (*sqliteStore, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxIdleTime(0)
	db.SetConnMaxLifetime(0)
	if _, err := db.Exec(schemaSQL); err != nil {
		_ = db.Close()
		return nil, err
	}
	resolved := map[string]logRetentionPolicy{
		categoryRuntime:   logRetentionPolicies[categoryRuntime],
		categoryOperation: logRetentionPolicies[categoryOperation],
		categoryLogin:     loginRetentionPolicy,
	}
	for category, policy := range policies {
		resolved[category] = policy
	}
	return &sqliteStore{db: db, policies: resolved}, nil
}

// tryRun 写入异常吞掉并计 failedWrites，对调用方零影响。
func (s *sqliteStore) tryRun(run func() error) {
	if err := run(); err != nil {
		s.failedWrites++
	}
}

// InsertRuntime 写运行日志（净化 → bytes → 硬闸 → 插入）。
func (s *sqliteStore) InsertRuntime(input runtimeInsert) {
	source := NormalizeSingleLine(input.Source, logSourceMaxLength)
	message := NormalizeSingleLine(input.Message, logMessageMaxLength)
	bytes := recordBytes(runtimeRecordJSON{At: input.At, Level: input.Level, Source: source, Message: message})
	s.mu.Lock()
	defer s.mu.Unlock()
	if bytes > logRecordMaxBytes {
		s.droppedRecords++
		return
	}
	s.tryRun(func() error {
		if input.SourceKey != nil {
			_, err := s.db.Exec(
				`INSERT OR IGNORE INTO runtime_logs (at, level, source, message, source_key, bytes)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				input.At, input.Level, source, message, *input.SourceKey, bytes,
			)
			return err
		}
		_, err := s.db.Exec(
			`INSERT INTO runtime_logs (at, level, source, message, source_key, bytes)
			 VALUES (?, ?, ?, ?, NULL, ?)`,
			input.At, input.Level, source, message, bytes,
		)
		return err
	})
}

// InsertLogin 写登录日志。
func (s *sqliteStore) InsertLogin(input loginInsert) {
	ip := NormalizeSingleLine(input.IP, logIPMaxLength)
	location := NormalizeSingleLine(input.Location, logLocationMaxLength)
	userAgent := NormalizeSingleLine(input.UserAgent, logUserAgentMaxLen)
	bytes := recordBytes(loginRecordJSON{
		At: input.At, IP: ip, Location: location, UserAgent: userAgent, Status: input.Status,
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	if bytes > logRecordMaxBytes {
		s.droppedRecords++
		return
	}
	s.tryRun(func() error {
		if input.SourceKey != nil {
			_, err := s.db.Exec(
				`INSERT OR IGNORE INTO login_logs (at, ip, location, user_agent, status, source_key, bytes)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				input.At, ip, location, userAgent, input.Status, *input.SourceKey, bytes,
			)
			return err
		}
		_, err := s.db.Exec(
			`INSERT INTO login_logs (at, ip, location, user_agent, status, source_key, bytes)
			 VALUES (?, ?, ?, ?, ?, NULL, ?)`,
			input.At, ip, location, userAgent, input.Status, bytes,
		)
		return err
	})
}

// InsertOperation 写操作日志。
func (s *sqliteStore) InsertOperation(input operationInsert) {
	action := NormalizeSingleLine(input.Action, logActionMaxLength)
	var target *string
	if input.Target != nil {
		normalized := NormalizeSingleLine(*input.Target, logTargetMaxLength)
		target = &normalized
	}
	summary := NormalizeSingleLine(input.Summary, logSummaryMaxLength)
	var method *string
	if input.Method != nil {
		normalized := NormalizeSingleLine(*input.Method, logMethodMaxLength)
		method = &normalized
	}
	var path *string
	if input.Path != nil {
		normalized := NormalizeSingleLine(*input.Path, logPathMaxLength)
		path = &normalized
	}
	bytes := recordBytes(operationRecordJSON{
		At: input.At, Category: input.Category, Action: action, Target: target,
		Result: input.Result, HTTPStatus: input.HTTPStatus, Method: method, Path: path, Summary: summary,
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	if bytes > logRecordMaxBytes {
		s.droppedRecords++
		return
	}
	s.tryRun(func() error {
		if input.SourceKey != nil {
			_, err := s.db.Exec(
				`INSERT OR IGNORE INTO operation_logs
				   (at, category, action, target, summary, result, method, path, http_status, source_key, bytes)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				input.At, input.Category, action, target, summary, input.Result, method, path,
				input.HTTPStatus, *input.SourceKey, bytes,
			)
			return err
		}
		_, err := s.db.Exec(
			`INSERT INTO operation_logs
			   (at, category, action, target, summary, result, method, path, http_status, source_key, bytes)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
			input.At, input.Category, action, target, summary, input.Result, method, path,
			input.HTTPStatus, bytes,
		)
		return err
	})
}

// ImportFile 单事务导入：sha256(整行) 作 sourceKey → INSERT OR IGNORE；坏行跳过并
// 计数；单行超限抛「日志记录超过大小上限，导入中止」整份回滚。
func (s *sqliteStore) ImportFile(category string, lines []string) (inserted, skipped int, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback() }()

	for _, line := range lines {
		if line == "" {
			continue
		}
		sourceKey := sha256Hex(line)
		if category == categoryRuntime {
			record := parseRuntimeLogLine(line)
			if record == nil {
				skipped++
				fmt.Fprintf(os.Stderr, "Elysian 日志导入跳过坏行（runtime）：%s\n", jsSlice(line, 200))
				continue
			}
			source := NormalizeSingleLine(record.source, logSourceMaxLength)
			message := NormalizeSingleLine(record.message, logMessageMaxLength)
			bytes := recordBytes(runtimeRecordJSON{At: record.at, Level: record.level, Source: source, Message: message})
			if bytes > logRecordMaxBytes {
				return 0, 0, fmt.Errorf("日志记录超过大小上限，导入中止")
			}
			if _, err := tx.Exec(
				`INSERT OR IGNORE INTO runtime_logs (at, level, source, message, source_key, bytes)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				record.at, record.level, source, message, sourceKey, bytes,
			); err != nil {
				return 0, 0, err
			}
			inserted++
			continue
		}
		if category == categoryLogin {
			record := parseLoginLogLine(line)
			if record == nil {
				skipped++
				fmt.Fprintf(os.Stderr, "Elysian 日志导入跳过坏行（login）：%s\n", jsSlice(line, 200))
				continue
			}
			ip := NormalizeSingleLine(record.ip, logIPMaxLength)
			location := NormalizeSingleLine(record.location, logLocationMaxLength)
			userAgent := NormalizeSingleLine(record.userAgent, logUserAgentMaxLen)
			bytes := recordBytes(loginRecordJSON{
				At: record.at, IP: ip, Location: location, UserAgent: userAgent, Status: record.status,
			})
			if bytes > logRecordMaxBytes {
				return 0, 0, fmt.Errorf("日志记录超过大小上限，导入中止")
			}
			if _, err := tx.Exec(
				`INSERT OR IGNORE INTO login_logs (at, ip, location, user_agent, status, source_key, bytes)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				record.at, ip, location, userAgent, record.status, sourceKey, bytes,
			); err != nil {
				return 0, 0, err
			}
			inserted++
			continue
		}
		record := parseOperationLogLine(line)
		if record == nil {
			skipped++
			fmt.Fprintf(os.Stderr, "Elysian 日志导入跳过坏行（operation）：%s\n", jsSlice(line, 200))
			continue
		}
		action := NormalizeSingleLine(record.action, logActionMaxLength)
		var target *string
		if record.target != nil {
			normalized := NormalizeSingleLine(*record.target, logTargetMaxLength)
			target = &normalized
		}
		summary := NormalizeSingleLine(record.summary, logSummaryMaxLength)
		var method *string
		if record.method != nil {
			normalized := NormalizeSingleLine(*record.method, logMethodMaxLength)
			method = &normalized
		}
		var path *string
		if record.path != nil {
			normalized := NormalizeSingleLine(*record.path, logPathMaxLength)
			path = &normalized
		}
		var httpStatus *int64
		if record.httpStatus != nil {
			v := int64(*record.httpStatus)
			httpStatus = &v
		}
		bytes := recordBytes(operationRecordJSON{
			At: record.at, Category: record.category, Action: action, Target: target,
			Result: record.result, HTTPStatus: httpStatus, Method: method, Path: path, Summary: summary,
		})
		if bytes > logRecordMaxBytes {
			return 0, 0, fmt.Errorf("日志记录超过大小上限，导入中止")
		}
		if _, err := tx.Exec(
			`INSERT OR IGNORE INTO operation_logs
			   (at, category, action, target, summary, result, method, path, http_status, source_key, bytes)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			record.at, record.category, action, target, summary, record.result, method, path,
			httpStatus, sourceKey, bytes,
		); err != nil {
			return 0, 0, err
		}
		inserted++
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return inserted, skipped, nil
}

// whereClause 游标/筛选/关键字的 SQL 与参数（total 侧剥游标）。
type whereClause struct {
	sql         string
	params      []any
	totalSQL    string
	totalParams []any
}

// buildLogWhere 组装 WHERE（与 TS queryTable 的 parts/params 构造逐行对齐）。
func buildLogWhere(query logListQuery, extraWhere string, extraParams []any, keywordSQL string, keywordCount int) whereClause {
	parts := []string{cursorSQL}
	params := make([]any, 0, 4+len(extraParams)+keywordCount)
	var before any
	var beforeID any
	if query.HasCursor {
		before = query.Before
		beforeID = query.BeforeID
	}
	params = append(params, before, before, before, beforeID)

	if extraWhere != "" {
		parts = append(parts, extraWhere)
		params = append(params, extraParams...)
	}

	keyword := ""
	if query.HasQ {
		keyword = trimJS(query.Q)
	}
	if keyword != "" && keywordSQL != "" {
		parts = append(parts, keywordSQL)
		pattern := likePattern(keyword)
		for i := 0; i < keywordCount; i++ {
			params = append(params, pattern)
		}
	}

	totalParts := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != cursorSQL {
			totalParts = append(totalParts, part)
		}
	}
	built := whereClause{
		sql:         joinAnd(parts),
		params:      params,
		totalSQL:    joinAnd(totalParts),
		totalParams: params[4:],
	}
	return built
}

// joinAnd AND 连接（空表回空串）。
func joinAnd(parts []string) string {
	if len(parts) == 0 {
		return ""
	}
	joined := parts[0]
	for _, part := range parts[1:] {
		joined += " AND " + part
	}
	return joined
}

// countWhere COUNT(*)（可无 WHERE）。
func (s *sqliteStore) countWhere(table, whereSQL string, params []any) int64 {
	query := "SELECT COUNT(*) FROM " + table
	if whereSQL != "" {
		query += " WHERE " + whereSQL
	}
	var n int64
	if err := s.db.QueryRow(query, params...).Scan(&n); err != nil {
		return 0
	}
	return n
}

// QueryRuntime 运行日志分页查询（关键字落 source/message）。
func (s *sqliteStore) QueryRuntime(query logListQuery) (logPage[RuntimeLogEntry], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	where := buildLogWhere(query, "", nil, `(source LIKE ? ESCAPE '\' OR message LIKE ? ESCAPE '\')`, 2)
	total := s.countWhere("runtime_logs", where.totalSQL, where.totalParams)
	remaining := s.countWhere("runtime_logs", where.sql, where.params)

	limit := clampQueryLimit(query.Limit, query.HasLimit)
	rows, err := s.db.Query(
		"SELECT id, at, level, source, message FROM runtime_logs WHERE "+where.sql+" ORDER BY at DESC, id DESC LIMIT ?",
		append(where.params, limit)...,
	)
	if err != nil {
		return logPage[RuntimeLogEntry]{}, err
	}
	defer rows.Close()
	entries := []RuntimeLogEntry{}
	for rows.Next() {
		var id int64
		var at, level, source, message string
		if err := rows.Scan(&id, &at, &level, &source, &message); err != nil {
			return logPage[RuntimeLogEntry]{}, err
		}
		entries = append(entries, RuntimeLogEntry{
			ID: fmt.Sprintf("%d", id), At: at, Level: level, Source: source, Message: message,
		})
	}
	if err := rows.Err(); err != nil {
		return logPage[RuntimeLogEntry]{}, err
	}
	return logPage[RuntimeLogEntry]{
		Entries:   entries,
		Total:     total,
		Truncated: remaining > int64(len(entries)),
	}, nil
}

// QueryLogin 登录日志分页查询（关键字落 ip/location/user_agent；time 字段映射自 at 列）。
func (s *sqliteStore) QueryLogin(query loginLogListQuery) (logPage[LoginLogEntry], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var status any
	if query.HasStatus {
		status = query.Status
	}
	where := buildLogWhere(
		query.logListQuery,
		"(? IS NULL OR status = ?)",
		[]any{status, status},
		`(ip LIKE ? ESCAPE '\' OR location LIKE ? ESCAPE '\' OR user_agent LIKE ? ESCAPE '\')`,
		3,
	)
	total := s.countWhere("login_logs", where.totalSQL, where.totalParams)
	remaining := s.countWhere("login_logs", where.sql, where.params)

	limit := clampQueryLimit(query.Limit, query.HasLimit)
	rows, err := s.db.Query(
		"SELECT id, at, ip, location, user_agent, status FROM login_logs WHERE "+where.sql+" ORDER BY at DESC, id DESC LIMIT ?",
		append(where.params, limit)...,
	)
	if err != nil {
		return logPage[LoginLogEntry]{}, err
	}
	defer rows.Close()
	entries := []LoginLogEntry{}
	for rows.Next() {
		var id int64
		var at, ip, location, userAgent, statusText string
		if err := rows.Scan(&id, &at, &ip, &location, &userAgent, &statusText); err != nil {
			return logPage[LoginLogEntry]{}, err
		}
		entries = append(entries, LoginLogEntry{
			ID: fmt.Sprintf("%d", id), IP: ip, Location: location, UserAgent: userAgent,
			Status: statusText, Time: at,
		})
	}
	if err := rows.Err(); err != nil {
		return logPage[LoginLogEntry]{}, err
	}
	return logPage[LoginLogEntry]{
		Entries:   entries,
		Total:     total,
		Truncated: remaining > int64(len(entries)),
	}, nil
}

// QueryOperation 操作日志分页查询（category/result 筛选；关键字落 action/summary/target）。
func (s *sqliteStore) QueryOperation(query operationLogListQuery) (logPage[OperationLogEntry], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var category any
	if query.HasCategory {
		category = query.Category
	}
	var result any
	if query.HasResult {
		result = query.Result
	}
	where := buildLogWhere(
		query.logListQuery,
		"(? IS NULL OR category = ?) AND (? IS NULL OR result = ?)",
		[]any{category, category, result, result},
		`(action LIKE ? ESCAPE '\' OR summary LIKE ? ESCAPE '\' OR IFNULL(target, '') LIKE ? ESCAPE '\')`,
		3,
	)
	total := s.countWhere("operation_logs", where.totalSQL, where.totalParams)
	remaining := s.countWhere("operation_logs", where.sql, where.params)

	limit := clampQueryLimit(query.Limit, query.HasLimit)
	rows, err := s.db.Query(
		"SELECT id, at, category, action, target, summary, result, method, path, http_status FROM operation_logs WHERE "+where.sql+" ORDER BY at DESC, id DESC LIMIT ?",
		append(where.params, limit)...,
	)
	if err != nil {
		return logPage[OperationLogEntry]{}, err
	}
	defer rows.Close()
	entries := []OperationLogEntry{}
	for rows.Next() {
		var id int64
		var at, categoryText, action, summary, resultText string
		var target, method, path sql.NullString
		var httpStatus sql.NullInt64
		if err := rows.Scan(&id, &at, &categoryText, &action, &target, &summary, &resultText, &method, &path, &httpStatus); err != nil {
			return logPage[OperationLogEntry]{}, err
		}
		entry := OperationLogEntry{
			ID: fmt.Sprintf("%d", id), At: at, Category: categoryText, Action: action,
			Summary: summary, Result: resultText,
		}
		if target.Valid {
			v := target.String
			entry.Target = &v
		}
		if method.Valid {
			v := method.String
			entry.Method = &v
		}
		if path.Valid {
			v := path.String
			entry.Path = &v
		}
		if httpStatus.Valid {
			v := httpStatus.Int64
			entry.HTTPStatus = &v
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return logPage[OperationLogEntry]{}, err
	}
	return logPage[OperationLogEntry]{
		Entries:   entries,
		Total:     total,
		Truncated: remaining > int64(len(entries)),
	}, nil
}

// Clear 清空单类别：事务内先取 COUNT/SUM/MIN 作报告再 DELETE。
func (s *sqliteStore) Clear(category string) (logClearStats, error) {
	table, ok := tableOf[category]
	if !ok {
		return logClearStats{}, fmt.Errorf("未知日志类别：%s", category)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return logClearStats{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var stats logClearStats
	var oldestAt sql.NullString
	if err := tx.QueryRow(
		"SELECT COUNT(*), COALESCE(SUM(bytes), 0), MIN(at) FROM "+table,
	).Scan(&stats.RowCount, &stats.TotalBytes, &oldestAt); err != nil {
		return logClearStats{}, err
	}
	if oldestAt.Valid {
		v := oldestAt.String
		stats.OldestAt = &v
	}
	if _, err := tx.Exec("DELETE FROM " + table); err != nil {
		return logClearStats{}, err
	}
	if err := tx.Commit(); err != nil {
		return logClearStats{}, err
	}
	return stats, nil
}

// Sweep 按龄删除 + 超预算从最旧删；异常兜底 stderr + failed:1 空结果（totalBytes 尽力补）。
func (s *sqliteStore) Sweep(category string, now time.Time) logSweepResult {
	table, ok := tableOf[category]
	if !ok {
		return emptySweep(1)
	}
	policy := s.policies[category]
	s.mu.Lock()
	defer s.mu.Unlock()

	result, err := s.sweepLocked(table, policy, now)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Elysian 日志巡检失败（%s）：%v\n", category, err)
		failed := emptySweep(1)
		if total, totalErr := s.sumBytes(table); totalErr == nil {
			failed.TotalBytes = total
		}
		return failed
	}
	return result
}

// sweepLocked 一次巡检（调用方持锁）。
func (s *sqliteStore) sweepLocked(table string, policy logRetentionPolicy, now time.Time) (logSweepResult, error) {
	var freedBytes int64
	cutoff := isoTime(now.Add(-time.Duration(policy.retentionDays) * dayDuration))

	var ageBytes int64
	if err := s.db.QueryRow(
		"SELECT COALESCE(SUM(bytes), 0) FROM "+table+" WHERE at < ?", cutoff,
	).Scan(&ageBytes); err != nil {
		return emptySweep(0), err
	}
	ageDelete, err := s.db.Exec("DELETE FROM "+table+" WHERE at < ?", cutoff)
	if err != nil {
		return emptySweep(0), err
	}
	deletedByAge, err := ageDelete.RowsAffected()
	if err != nil {
		deletedByAge = 0
	}
	freedBytes += ageBytes

	rows, err := s.db.Query("SELECT id, bytes FROM " + table + " ORDER BY at ASC, id ASC")
	if err != nil {
		return emptySweep(0), err
	}
	type idBytes struct {
		id    int64
		bytes int64
	}
	var all []idBytes
	var total int64
	for rows.Next() {
		var row idBytes
		if err := rows.Scan(&row.id, &row.bytes); err != nil {
			_ = rows.Close()
			return emptySweep(0), err
		}
		all = append(all, row)
		total += row.bytes
	}
	_ = rows.Close()

	var deleteIDs []int64
	deletedBySize := 0
	for _, row := range all {
		if total <= policy.maxTotalBytes {
			break
		}
		deleteIDs = append(deleteIDs, row.id)
		total -= row.bytes
		freedBytes += row.bytes
		deletedBySize++
	}
	if len(deleteIDs) > 0 {
		placeholder := ""
		args := make([]any, 0, len(deleteIDs))
		for i, id := range deleteIDs {
			if i > 0 {
				placeholder += ", "
			}
			placeholder += "?"
			args = append(args, id)
		}
		if _, err := s.db.Exec("DELETE FROM "+table+" WHERE id IN ("+placeholder+")", args...); err != nil {
			return emptySweep(0), err
		}
	}

	totalBytes, err := s.sumBytes(table)
	if err != nil {
		return emptySweep(0), err
	}
	return logSweepResult{
		DeletedByAge:  int(deletedByAge),
		DeletedBySize: deletedBySize,
		FreedBytes:    freedBytes,
		TotalBytes:    totalBytes,
		TrimmedBySize: deletedBySize > 0,
	}, nil
}

// sumBytes 表内字节合计。
func (s *sqliteStore) sumBytes(table string) (int64, error) {
	var n int64
	err := s.db.QueryRow("SELECT COALESCE(SUM(bytes), 0) FROM " + table).Scan(&n)
	return n, err
}

// countRows 表内行数。
func (s *sqliteStore) countRows(table string) (int64, error) {
	var n int64
	err := s.db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n)
	return n, err
}

// minAt 表内最旧 at。
func (s *sqliteStore) minAt(table string) (*string, error) {
	var at sql.NullString
	err := s.db.QueryRow("SELECT MIN(at) FROM " + table).Scan(&at)
	if err != nil {
		return nil, err
	}
	if !at.Valid {
		return nil, nil
	}
	v := at.String
	return &v, nil
}

// Storage 全库（runtime+operation 两表合计）统计；登录日志不计入；透传巡检字段。
func (s *sqliteStore) Storage(lastSweepAt *string, trimmedBySize bool) LogStorageStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	runtimeBytes, _ := s.sumBytes("runtime_logs")
	operationBytes, _ := s.sumBytes("operation_logs")
	runtimeCount, _ := s.countRows("runtime_logs")
	operationCount, _ := s.countRows("operation_logs")
	runtimeOldest, _ := s.minAt("runtime_logs")
	operationOldest, _ := s.minAt("operation_logs")

	var oldestAt *string
	if runtimeOldest != nil && operationOldest != nil {
		if *runtimeOldest < *operationOldest {
			oldestAt = runtimeOldest
		} else {
			oldestAt = operationOldest
		}
	} else if runtimeOldest != nil {
		oldestAt = runtimeOldest
	} else {
		oldestAt = operationOldest
	}

	return LogStorageStats{
		TotalBytes:        runtimeBytes + operationBytes,
		RuntimeBytes:      runtimeBytes,
		OperationBytes:    operationBytes,
		RuntimeRowCount:   runtimeCount,
		OperationRowCount: operationCount,
		RowCount:          runtimeCount + operationCount,
		OldestAt:          oldestAt,
		LastSweepAt:       lastSweepAt,
		TrimmedBySize:     trimmedBySize,
		DroppedRecords:    int64(s.droppedRecords),
		FailedWrites:      int64(s.failedWrites),
	}
}

// Counters 进程内计数器（内存态、不落盘，重启归零）。
func (s *sqliteStore) Counters() (int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.droppedRecords, s.failedWrites
}

// Close 关库。
func (s *sqliteStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Close()
}
