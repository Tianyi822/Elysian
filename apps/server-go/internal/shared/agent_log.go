package shared

import "strconv"

// AgentLogPage paginates already-redacted structured facts, never free output.
func AgentLogPage(entries []any, cursor string, limit int) (map[string]any, error) {
	offset := 0
	if cursor != "" {
		parsed, err := strconv.Atoi(cursor)
		if err != nil || parsed < 0 || strconv.Itoa(parsed) != cursor {
			return nil, InvalidRequest("结构化日志游标无效")
		}
		offset = parsed
	}
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 100 {
		return nil, InvalidRequest("日志分页数量须为 1 到 100")
	}
	if offset > len(entries) {
		return nil, InvalidRequest("结构化日志游标超出范围")
	}
	end := offset + limit
	if end > len(entries) {
		end = len(entries)
	}
	next := ""
	if end < len(entries) {
		next = strconv.Itoa(end)
	}
	return map[string]any{"entries": entries[offset:end], "cursor": cursor, "limit": limit, "next": next, "hasMore": next != ""}, nil
}
