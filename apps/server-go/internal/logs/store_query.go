package logs

import (
	"database/sql"
	"fmt"
)

// cursorSQL 游标过滤：严格更早（at 更小，或同刻 id 更小）。
const cursorSQL = "(? IS NULL OR at < ? OR (at = ? AND id < ?))"

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

type logTable[T any] struct {
	name    string
	columns string
	scan    func(*sql.Rows) (T, error)
}

// queryLocked 保持总数与分页读取在同一把存储锁内。
func (table logTable[T]) queryLocked(s *sqliteStore, where whereClause, query logListQuery) (logPage[T], error) {
	total := s.countWhere(table.name, where.totalSQL, where.totalParams)
	remaining := s.countWhere(table.name, where.sql, where.params)

	limit := clampQueryLimit(query.Limit, query.HasLimit)
	rows, err := s.db.Query(
		"SELECT "+table.columns+" FROM "+table.name+" WHERE "+where.sql+" ORDER BY at DESC, id DESC LIMIT ?",
		append(where.params, limit)...,
	)
	if err != nil {
		return logPage[T]{}, err
	}
	defer rows.Close()
	entries := []T{}
	for rows.Next() {
		entry, err := table.scan(rows)
		if err != nil {
			return logPage[T]{}, err
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return logPage[T]{}, err
	}
	return logPage[T]{
		Entries:   entries,
		Total:     total,
		Truncated: remaining > int64(len(entries)),
	}, nil
}

var runtimeLogTable = logTable[RuntimeLogEntry]{
	name:    "runtime_logs",
	columns: "id, at, level, source, message",
	scan: func(rows *sql.Rows) (RuntimeLogEntry, error) {
		var id int64
		var at, level, source, message string
		if err := rows.Scan(&id, &at, &level, &source, &message); err != nil {
			return RuntimeLogEntry{}, err
		}
		return RuntimeLogEntry{ID: fmt.Sprintf("%d", id), At: at, Level: level, Source: source, Message: message}, nil
	},
}

// QueryRuntime 运行日志分页查询（关键字落 source/message）。
func (s *sqliteStore) QueryRuntime(query logListQuery) (logPage[RuntimeLogEntry], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	where := buildLogWhere(query, "", nil, `(source LIKE ? ESCAPE '\' OR message LIKE ? ESCAPE '\')`, 2)
	return runtimeLogTable.queryLocked(s, where, query)
}

var loginLogTable = logTable[LoginLogEntry]{
	name:    "login_logs",
	columns: "id, at, ip, location, user_agent, status",
	scan: func(rows *sql.Rows) (LoginLogEntry, error) {
		var id int64
		var at, ip, location, userAgent, status string
		if err := rows.Scan(&id, &at, &ip, &location, &userAgent, &status); err != nil {
			return LoginLogEntry{}, err
		}
		return LoginLogEntry{
			ID: fmt.Sprintf("%d", id), IP: ip, Location: location, UserAgent: userAgent,
			Status: status, Time: at,
		}, nil
	},
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
	return loginLogTable.queryLocked(s, where, query.logListQuery)
}

var operationLogTable = logTable[OperationLogEntry]{
	name:    "operation_logs",
	columns: "id, at, category, action, target, summary, result, method, path, http_status",
	scan: func(rows *sql.Rows) (OperationLogEntry, error) {
		var id int64
		var at, categoryText, action, summary, resultText string
		var target, method, path sql.NullString
		var httpStatus sql.NullInt64
		if err := rows.Scan(&id, &at, &categoryText, &action, &target, &summary, &resultText, &method, &path, &httpStatus); err != nil {
			return OperationLogEntry{}, err
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
		return entry, nil
	},
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
	return operationLogTable.queryLocked(s, where, query.logListQuery)
}
