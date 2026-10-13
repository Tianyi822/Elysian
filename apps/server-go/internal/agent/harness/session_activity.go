package harness

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
)

// 活动游标与原有 rowid 数字游标属于不同分页协议，不能互换。
type sessionActivityCursor struct {
	Version    int    `json:"v"`
	ActivityMS *int64 `json:"ms"`
	ID         string `json:"id"`
}

func decodeSessionActivityCursor(raw string) (sessionActivityCursor, error) {
	var cursor sessionActivityCursor
	if raw == "" {
		return cursor, nil
	}
	invalid := func() (sessionActivityCursor, error) {
		return sessionActivityCursor{}, bad("invalid-cursor", "会话活动分页游标无效，请刷新列表")
	}
	if len(raw) > 256 {
		return invalid()
	}
	payload, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	if err != nil {
		return invalid()
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&cursor); err != nil || cursor.Version != 1 || cursor.ActivityMS == nil || cursor.ID == "" {
		return invalid()
	}
	if err = decoder.Decode(new(any)); err != io.EOF {
		return invalid()
	}
	return cursor, nil
}

func encodeSessionActivityCursor(ms int64, id string) string {
	payload, _ := json.Marshal(sessionActivityCursor{Version: 1, ActivityMS: &ms, ID: id})
	return base64.RawURLEncoding.EncodeToString(payload)
}

// stamp 保证活动时间为 UTC RFC3339Nano。先取整秒再截断小数至毫秒，
// 避免 RFC3339Nano 的可变小数位字典序及 SQLite 日期函数四舍五入改变边界。
const sessionActivityMillisSQL = `CAST(strftime('%s', substr(last_activity_at,1,19) || 'Z') AS INTEGER) * 1000
 + CASE WHEN substr(last_activity_at,20,1)='.'
   THEN CAST(substr(rtrim(substr(last_activity_at,21),'Z') || '000',1,3) AS INTEGER)
   ELSE 0 END`

func (s *store) sessionsByActivity(ctx context.Context, cursorRaw string, n int) (Page[Session], error) {
	page := Page[Session]{Items: []Session{}}
	limit, err := pageSize(n, 50)
	if err != nil {
		return page, err
	}
	cursor, err := decodeSessionActivityCursor(cursorRaw)
	if err != nil {
		return page, err
	}
	var activityMS int64
	if cursor.ActivityMS != nil {
		activityMS = *cursor.ActivityMS
	}
	rows, err := s.db.QueryContext(ctx, `WITH activity_sessions AS (
 SELECT id,document,`+sessionActivityMillisSQL+` AS activity_ms FROM sessions
 ) SELECT activity_ms,id,document FROM activity_sessions
 WHERE (?='' OR activity_ms<? OR (activity_ms=? AND id<?))
 ORDER BY activity_ms DESC,id DESC LIMIT ?`, cursorRaw, activityMS, activityMS, cursor.ID, limit+1)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	var lastMS int64
	var lastID string
	for rows.Next() {
		if len(page.Items) == limit {
			page.HasMore = true
			break
		}
		var raw string
		var session Session
		if err = rows.Scan(&lastMS, &lastID, &raw); err != nil {
			return page, err
		}
		if err = json.Unmarshal([]byte(raw), &session); err != nil {
			return page, err
		}
		page.Items = append(page.Items, session)
	}
	if page.HasMore {
		page.NextCursor = encodeSessionActivityCursor(lastMS, lastID)
	}
	return page, rows.Err()
}
