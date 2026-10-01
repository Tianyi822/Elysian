package logs

import (
	"fmt"
	"net/url"

	"elysian/server/internal/shared"
)

/*
 * 三个列表端点的查询参数解析与校验（logListQuery.ts 等价物；400 文案逐字契约）。
 */

// logListQuery 公共查询参数（全部可选；Has 前缀区分「未提供」与零值）。
type logListQuery struct {
	Q         string
	HasQ      bool
	Limit     int
	HasLimit  bool
	Before    string
	BeforeID  int64
	HasCursor bool
}

// operationLogListQuery 操作日志查询：公共参数 + category/result。
type operationLogListQuery struct {
	logListQuery
	Category    string
	HasCategory bool
	Result      string
	HasResult   bool
}

// loginLogListQuery 登录日志查询：公共参数 + status。
type loginLogListQuery struct {
	logListQuery
	Status    string
	HasStatus bool
}

// parseSharedListQuery 公共参数解析（400 即回 InvalidRequestError）。
func parseSharedListQuery(values url.Values) (logListQuery, error) {
	var query logListQuery

	if raw, ok := values["q"]; ok {
		query.HasQ = true
		if len(raw) > 0 && raw[0] != "" {
			query.Q = raw[0]
		}
	}

	if raw, ok := values["limit"]; ok {
		if len(raw) == 0 {
			raw = []string{""}
		}
		n, okNumber := parseJSNumber(raw[0])
		if !okNumber || !isJSIntegerNumber(n) || n < 1 || n > float64(logEntryFetchLimit) {
			return query, shared.InvalidRequest(fmt.Sprintf("limit 无效：应为 1 到 %d 的整数", logEntryFetchLimit))
		}
		query.HasLimit = true
		query.Limit = int(n)
	}

	hasBefore := hasKey(values, "before")
	hasBeforeID := hasKey(values, "beforeId")
	if hasBefore != hasBeforeID {
		return query, shared.InvalidRequest("before 与 beforeId 必须成对提供")
	}
	if hasBefore && hasBeforeID {
		before := firstValue(values, "before")
		if !dateParses(before) {
			return query, shared.InvalidRequest("before 无效：应为可解析的时间")
		}
		beforeIDRaw := firstValue(values, "beforeId")
		if !beforeIDValid(beforeIDRaw) {
			return query, shared.InvalidRequest("beforeId 无效：应为正整数")
		}
		query.HasCursor = true
		query.Before = before
		query.BeforeID = parseInt64Clamped(beforeIDRaw)
	}

	return query, nil
}

// ParseRuntimeListQuery 运行日志查询解析。
func ParseRuntimeListQuery(values url.Values) (logListQuery, error) {
	return parseSharedListQuery(values)
}

// ParseOperationListQuery 操作日志查询解析。
func ParseOperationListQuery(values url.Values) (operationLogListQuery, error) {
	var query operationLogListQuery
	sharedQuery, err := parseSharedListQuery(values)
	if err != nil {
		return query, err
	}
	query.logListQuery = sharedQuery

	if _, ok := values["category"]; ok {
		category := firstValue(values, "category")
		if !containsString(operationLogCategories, category) {
			return query, shared.InvalidRequest(fmt.Sprintf("操作日志分类无效：%s", category))
		}
		query.HasCategory = true
		query.Category = category
	}

	if _, ok := values["result"]; ok {
		result := firstValue(values, "result")
		if !containsString(operationLogOutcomes, result) {
			return query, shared.InvalidRequest(fmt.Sprintf("操作结果无效：%s", result))
		}
		query.HasResult = true
		query.Result = result
	}

	return query, nil
}

// ParseLoginListQuery 登录日志查询解析。
func ParseLoginListQuery(values url.Values) (loginLogListQuery, error) {
	var query loginLogListQuery
	sharedQuery, err := parseSharedListQuery(values)
	if err != nil {
		return query, err
	}
	query.logListQuery = sharedQuery

	if _, ok := values["status"]; ok {
		status := firstValue(values, "status")
		if !containsString(loginLogStatuses, status) {
			return query, shared.InvalidRequest(fmt.Sprintf("登录状态无效：%s", status))
		}
		query.HasStatus = true
		query.Status = status
	}

	return query, nil
}

// hasKey 参数存在性（含空值）；URLSearchParams.has 的等价物。
func hasKey(values url.Values, key string) bool {
	_, ok := values[key]
	return ok
}

// firstValue 首个取值（缺省空串）；URLSearchParams.get 的等价物。
func firstValue(values url.Values, key string) string {
	if raw, ok := values[key]; ok && len(raw) > 0 {
		return raw[0]
	}
	return ""
}

// parseInt64Clamped 正整数十进制 → int64（超界饱和，取值只用于 SQL 游标比较）。
func parseInt64Clamped(raw string) int64 {
	var n int64
	for i := 0; i < len(raw); i++ {
		d := int64(raw[i] - '0')
		if n > (1<<63-1-d)/10 {
			return 1<<63 - 1
		}
		n = n*10 + d
	}
	return n
}
