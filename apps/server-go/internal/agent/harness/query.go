package harness

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
)

func pageSize(n, def int) (int, error) {
	if n == 0 {
		return def, nil
	}
	if n < 1 || n > 200 {
		return 0, &Error{Status: 400, Code: "invalid-page", Message: "每页条数必须在 1 到 200 之间"}
	}
	return n, nil
}
func numberCursor(raw string) (int64, error) {
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 0 || strconv.FormatInt(n, 10) != raw {
		return 0, &Error{Status: 400, Code: "invalid-cursor", Message: "分页游标无效"}
	}
	return n, nil
}
func (s *store) list(ctx context.Context, q ListQuery) (Page[Run], error) {
	p := Page[Run]{Items: []Run{}}
	limit, err := pageSize(q.Limit, 50)
	if err != nil {
		return p, err
	}
	cursor, err := numberCursor(q.Cursor)
	if err != nil {
		return p, err
	}
	if q.Status != "" && !validState(q.Status) {
		return p, &Error{Status: 400, Code: "invalid-state", Message: "运行状态无效"}
	}
	rows, err := s.db.QueryContext(ctx, `SELECT runs.rowid,runs.document FROM runs
 WHERE (?='' OR runs.state=?) AND (?='' OR runs.request_id=?) AND (?='' OR runs.session_id=?) AND (?='' OR runs.task_id=?)
 AND (?='' OR runs.workflow_id=?) AND (?=0 OR runs.rowid<?) ORDER BY runs.rowid DESC LIMIT ?`, q.Status, q.Status, q.RequestID, q.RequestID, q.SessionID, q.SessionID, q.TaskID, q.TaskID, q.WorkflowID, q.WorkflowID, cursor, cursor, limit+1)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	var last int64
	for rows.Next() {
		var id int64
		var raw string
		var r Run
		if err = rows.Scan(&id, &raw); err != nil {
			return p, err
		}
		if len(p.Items) == limit {
			p.HasMore = true
			break
		}
		if err = json.Unmarshal([]byte(raw), &r); err != nil {
			return p, err
		}
		p.Items = append(p.Items, r)
		last = id
	}
	if p.HasMore {
		p.NextCursor = strconv.FormatInt(last, 10)
	}
	return p, rows.Err()
}
func (s *store) calls(ctx context.Context, id, rawCursor string, n int) (Page[Call], error) {
	p := Page[Call]{Items: []Call{}}
	limit, err := pageSize(n, 50)
	if err != nil {
		return p, err
	}
	cursor, err := numberCursor(rawCursor)
	if err != nil {
		return p, err
	}
	if _, err = readRun(ctx, s.db, id); err != nil {
		return p, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT step_index,document FROM calls WHERE run_id=? AND step_index>=? ORDER BY step_index LIMIT ?", id, cursor, limit+1)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	last := int64(0)
	for rows.Next() {
		var index int64
		var raw string
		var c Call
		if err = rows.Scan(&index, &raw); err != nil {
			return p, err
		}
		if len(p.Items) == limit {
			p.HasMore = true
			break
		}
		if err = json.Unmarshal([]byte(raw), &c); err != nil {
			return p, err
		}
		p.Items = append(p.Items, c)
		last = index + 1
	}
	if p.HasMore {
		p.NextCursor = strconv.FormatInt(last, 10)
	}
	return p, rows.Err()
}
func (s *store) events(ctx context.Context, id, after string, n int) (Page[Event], error) {
	p := Page[Event]{Items: []Event{}}
	limit, err := pageSize(n, 100)
	if err != nil {
		return p, err
	}
	cursor, err := numberCursor(after)
	if err != nil {
		return p, err
	}
	r, err := readRun(ctx, s.db, id)
	if err != nil {
		return p, err
	}
	last, _ := strconv.ParseInt(r.LastSeq, 10, 64)
	if cursor > last {
		return p, &Error{Status: 400, Code: "future-cursor", Message: "事件游标超过当前运行进度"}
	}
	rows, err := s.db.QueryContext(ctx, "SELECT document FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?", id, cursor, limit+1)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	p.NextCursor = strconv.FormatInt(cursor, 10)
	for rows.Next() {
		var raw string
		var e Event
		if err = rows.Scan(&raw); err != nil {
			return p, err
		}
		if len(p.Items) == limit {
			p.HasMore = true
			break
		}
		if err = json.Unmarshal([]byte(raw), &e); err != nil {
			return p, err
		}
		p.Items = append(p.Items, e)
		p.NextCursor = e.Seq
	}
	return p, rows.Err()
}
func validState(s string) bool {
	if s == StateWaitingApproval || s == StateWaitingResource || s == StateRecoveryRequired {
		return true
	}
	switch s {
	case StateQueued, StateRunning, StateSucceeded, StateFailed, StateCancelled, StateInterrupted:
		return true
	}
	return false
}
func terminal(s string) bool {
	return s == StateSucceeded || s == StateFailed || s == StateCancelled || s == StateInterrupted
}
func bad(code, message string) error { return &Error{Status: 400, Code: code, Message: message} }
func storageFailure(err error) error {
	if err == nil {
		return nil
	}
	if _, ok := err.(*Error); ok {
		return err
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return &Error{Status: 408, Code: "request-cancelled", Message: "请求已取消或超时，可使用原请求标识查询结果"}
	}
	return &Error{Status: 503, Code: "storage-unavailable", Message: "任务存储不可用，无法确认运行状态"}
}
