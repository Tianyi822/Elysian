package harness

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"reflect"
	"strconv"
	"testing"
	"time"
)

func createActivitySession(t *testing.T, s *store, id, timestamp string) Session {
	t.Helper()
	session := Session{ID: id, Title: id, CreatedAt: timestamp, LastActivityAt: timestamp, ModelProfileID: "model-one", ModelRevision: 1, LastSeq: "0"}
	if err := s.createSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	return session
}

func activitySessionIDs(page Page[Session]) []string {
	ids := make([]string, len(page.Items))
	for i, item := range page.Items {
		ids[i] = item.ID
	}
	return ids
}

func TestSessionActivityPaginationTruncatesToMillisecondsAndUsesIDTiebreaker(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	for _, fixture := range []struct{ id, timestamp string }{
		{"zero-a", "2026-10-13T12:00:00Z"},
		{"fraction-z", "2026-10-13T12:00:00.1Z"},
		{"second", "2026-10-13T12:00:01Z"},
		{"end-z", "2026-10-13T12:00:00.999000001Z"},
		{"fraction-a", "2026-10-13T12:00:00.100999999Z"},
		{"zero-z", "2026-10-13T12:00:00.000000001Z"},
		{"end-a", "2026-10-13T12:00:00.999999999Z"},
		{"earlier", "2026-10-13T11:59:59.999999999Z"},
	} {
		createActivitySession(t, s, fixture.id, fixture.timestamp)
	}
	want := []string{"second", "end-z", "end-a", "fraction-z", "fraction-a", "zero-z", "zero-a", "earlier"}
	for _, limit := range []int{1, 2, 3, 8, 20} {
		t.Run(strconv.Itoa(limit), func(t *testing.T) {
			var ids []string
			cursor := ""
			for requests := 0; ; requests++ {
				if requests > len(want) {
					t.Fatal("分页没有结束")
				}
				page, err := s.sessionsByActivity(context.Background(), cursor, limit)
				if err != nil {
					t.Fatal(err)
				}
				ids = append(ids, activitySessionIDs(page)...)
				if !page.HasMore {
					if page.NextCursor != "" {
						t.Fatalf("末页保留了续页游标：%+v", page)
					}
					break
				}
				decoded, err := decodeSessionActivityCursor(page.NextCursor)
				last := page.Items[len(page.Items)-1]
				at, parseErr := time.Parse(time.RFC3339Nano, last.LastActivityAt)
				if err != nil || parseErr != nil || decoded.ID != last.ID || decoded.ActivityMS == nil || *decoded.ActivityMS != at.UnixMilli() {
					t.Fatalf("游标没有使用同一个毫秒边界：%+v %+v %v %v", decoded, last, err, parseErr)
				}
				cursor = page.NextCursor
			}
			if !reflect.DeepEqual(ids, want) {
				t.Fatalf("活动分页遗漏、重复或排序错误：%v，预期 %v", ids, want)
			}
		})
	}
	legacy, err := s.sessions(context.Background(), "", 2)
	if err != nil || !reflect.DeepEqual(activitySessionIDs(legacy), []string{"earlier", "end-a"}) || legacy.NextCursor != "7" {
		t.Fatalf("默认 rowid 分页发生变化：%+v %v", legacy, err)
	}
	legacy, err = s.sessions(context.Background(), legacy.NextCursor, 2)
	if err != nil || !reflect.DeepEqual(activitySessionIDs(legacy), []string{"zero-z", "fraction-a"}) || legacy.NextCursor != "5" {
		t.Fatalf("旧数字游标不能续页：%+v %v", legacy, err)
	}
}

func TestSessionActivityCursorSurvivesDeletedAnchorAndRefreshUsesLatestActivity(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	ctx := context.Background()
	createActivitySession(t, s, "latest", "2026-10-13T12:00:02Z")
	createActivitySession(t, s, "middle", "2026-10-13T12:00:01Z")
	old := createActivitySession(t, s, "oldest", "2026-10-13T12:00:00Z")
	first, err := s.sessionsByActivity(ctx, "", 1)
	if err != nil || !reflect.DeepEqual(activitySessionIDs(first), []string{"latest"}) {
		t.Fatalf("首页错误：%+v %v", first, err)
	}
	if _, err = s.db.ExecContext(ctx, "DELETE FROM sessions WHERE id='latest'"); err != nil {
		t.Fatal(err)
	}
	page, err := s.sessionsByActivity(ctx, first.NextCursor, 1)
	if err != nil || !reflect.DeepEqual(activitySessionIDs(page), []string{"middle"}) {
		t.Fatalf("锚点被清理后不能翻页：%+v %v", page, err)
	}
	old.LastActivityAt = "2026-10-13T12:00:03.000000001Z"
	if err = s.createSession(ctx, old); err != nil {
		t.Fatal(err)
	}
	page, err = s.sessionsByActivity(ctx, "", 1)
	if err != nil || !reflect.DeepEqual(activitySessionIDs(page), []string{"oldest"}) {
		t.Fatalf("刷新后没有按最新活动排序：%+v %v", page, err)
	}
}

func TestSessionActivityRejectsInvalidAndMixedCursors(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	ctx := context.Background()
	encode := func(raw string) string { return base64.RawURLEncoding.EncodeToString([]byte(raw)) }
	for _, cursor := range []string{
		"0", "12", "not-a-cursor", encode(`null`), encode(`{}`),
		encode(`{"v":2,"ms":0,"id":"session"}`),
		encode(`{"v":1,"id":"session"}`),
		encode(`{"v":1,"ms":0,"id":""}`),
		encode(`{"v":1,"ms":0,"id":"session","extra":true}`),
		encode(`{"v":1,"ms":0,"id":"session"}{}`),
	} {
		if _, err := s.sessionsByActivity(ctx, cursor, 50); err == nil {
			t.Fatalf("接受无效活动游标：%q", cursor)
		} else {
			var invalid *Error
			if !errors.As(err, &invalid) || invalid.Status != 400 || invalid.Code != "invalid-cursor" {
				t.Fatalf("游标错误没有明确返回 400：%v", err)
			}
		}
	}
	cursor := encodeSessionActivityCursor(1, "session")
	if _, err := s.sessions(ctx, cursor, 50); err == nil {
		t.Fatal("旧数字分页接受活动游标")
	}
	if _, err := s.sessionsByActivity(ctx, "", 201); err == nil {
		t.Fatal("活动分页接受超限条数")
	}
	page, err := s.sessionsByActivity(ctx, "", 1)
	if err != nil || page.Items == nil || len(page.Items) != 0 || page.HasMore || page.NextCursor != "" {
		t.Fatalf("空列表形状错误：%+v %v", page, err)
	}
}

func TestAgentRoutesSessionActivitySortAndCursorValidation(t *testing.T) {
	m, _ := sessionAPIManager(t)
	createActivitySession(t, m.store, "first", "2026-10-13T12:00:01Z")
	createActivitySession(t, m.store, "last", "2026-10-13T12:00:00Z")
	handler := m.Router()
	response := runtimeRouteRequest(handler, "GET", "/sessions?sort=activity&limit=1", "")
	var page Page[Session]
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &page) != nil || !reflect.DeepEqual(activitySessionIDs(page), []string{"first"}) || !page.HasMore {
		t.Fatalf("活动排序路由错误：%d %s", response.Code, response.Body.String())
	}
	cursor := page.NextCursor
	response = runtimeRouteRequest(handler, "GET", "/sessions?sort=activity&limit=1&cursor="+url.QueryEscape(cursor), "")
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &page) != nil || !reflect.DeepEqual(activitySessionIDs(page), []string{"last"}) || page.HasMore {
		t.Fatalf("活动分页路由错误：%d %s", response.Code, response.Body.String())
	}
	response = runtimeRouteRequest(handler, "GET", "/sessions?limit=1", "")
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &page) != nil || !reflect.DeepEqual(activitySessionIDs(page), []string{"last"}) || page.NextCursor != "2" {
		t.Fatalf("默认列表不兼容：%d %s", response.Code, response.Body.String())
	}
	for _, query := range []string{
		"sort=unknown", "sort=", "sort=activity&sort=activity", "sort=activity&cursor=1", "cursor=" + url.QueryEscape(cursor),
	} {
		response = runtimeRouteRequest(handler, "GET", "/sessions?"+query, "")
		if response.Code != 400 {
			t.Fatalf("接受无效列表查询 %q：%d %s", query, response.Code, response.Body.String())
		}
	}
}
