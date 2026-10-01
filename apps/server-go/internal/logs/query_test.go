package logs

import (
	"net/http"
	"net/url"
	"testing"

	"elysian/server/internal/shared"
)

// newRequest 测试用请求构造（Origin/Host 缺省不带）。
func newRequest(method, target, body, contentType string) *http.Request {
	req, err := http.NewRequest(method, target, nil)
	if err != nil {
		panic(err)
	}
	return req
}

// mustQueryValues 解析查询串。
func mustQueryValues(t *testing.T, rawQuery string) url.Values {
	t.Helper()
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		t.Fatalf("解析查询串失败：%v", err)
	}
	return values
}

// assertInvalidMessage 断言 400 与逐字文案。
func assertInvalidMessage(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("应返回错误：%s", want)
	}
	invalid, ok := err.(*shared.InvalidRequestError)
	if !ok {
		t.Fatalf("应为 InvalidRequestError，得 %T", err)
	}
	if invalid.Status != 400 {
		t.Errorf("状态码 = %d, want 400", invalid.Status)
	}
	if invalid.Message != want {
		t.Errorf("错误文案 = %q, want %q", invalid.Message, want)
	}
}

// 合法组合全量通过（logListQuery.test.ts）。
func TestParseListQueryValid(t *testing.T) {
	q, err := ParseRuntimeListQuery(mustQueryValues(t, ""))
	if err != nil || q.HasQ || q.HasLimit || q.HasCursor {
		t.Errorf("空查询应全空：%+v %v", q, err)
	}

	q, err = ParseRuntimeListQuery(mustQueryValues(t, "q=error&limit=10&before=2026-09-23T00:00:02.000Z&beforeId=7"))
	if err != nil {
		t.Fatalf("合法组合被拒：%v", err)
	}
	if q.Q != "error" || q.Limit != 10 || q.Before != "2026-09-23T00:00:02.000Z" || q.BeforeID != 7 {
		t.Errorf("字段不符：%+v", q)
	}

	// JS Number() 语义：1e2、1e3（=1000 恰在上限）、0x10、带空白、10.0、010 都合法。
	for _, raw := range []string{"1e2", "1e3", "0x10", "+10", " 10 ", "10.0", "010"} {
		q, err = ParseRuntimeListQuery(mustQueryValues(t, "limit="+urlQueryEscape(raw)))
		if err != nil {
			t.Errorf("limit=%q 应合法：%v", raw, err)
			continue
		}
		want := 10
		switch raw {
		case "1e2":
			want = 100
		case "1e3":
			want = 1000
		case "0x10":
			want = 16
		}
		if q.Limit != want {
			t.Errorf("limit=%q 解析为 %d, want %d", raw, q.Limit, want)
		}
	}

	// before 的常见形。
	for _, before := range []string{
		"2026-09-23T00:00:02.000Z",
		"2026-09-23T00:00:02Z",
		"2026-09-23T00:00:02+08:00",
		"2026-09-23",
	} {
		if _, err = ParseRuntimeListQuery(mustQueryValues(t, "before="+urlQueryEscape(before)+"&beforeId=1")); err != nil {
			t.Errorf("before=%q 应合法：%v", before, err)
		}
	}

	// q 与 limit 的空值：q 不设过滤、limit 空串按 0 处理（越界 400 同文案）。
	if q, err = ParseRuntimeListQuery(mustQueryValues(t, "q=")); err != nil || !q.HasQ || q.Q != "" {
		t.Errorf("q= 应保留空值不设过滤：%+v %v", q, err)
	}
}

// urlQueryEscape 简易转义（测试内拼查询串用）。
func urlQueryEscape(s string) string {
	values := url.Values{}
	values.Set("v", s)
	return values.Encode()[2:]
}

// 400 文案逐字断言（logListQuery.test.ts）。
func TestParseListQueryInvalid(t *testing.T) {
	cases := []struct {
		rawQuery string
		want     string
	}{
		{"limit=0", "limit 无效：应为 1 到 1000 的整数"},
		{"limit=1001", "limit 无效：应为 1 到 1000 的整数"},
		{"limit=1000.5", "limit 无效：应为 1 到 1000 的整数"},
		{"limit=abc", "limit 无效：应为 1 到 1000 的整数"},
		{"limit=", "limit 无效：应为 1 到 1000 的整数"},
		{"limit=1e4", "limit 无效：应为 1 到 1000 的整数"},
		{"before=2026-09-23T00:00:02.000Z", "before 与 beforeId 必须成对提供"},
		{"beforeId=7", "before 与 beforeId 必须成对提供"},
		{"before=nope&beforeId=7", "before 无效：应为可解析的时间"},
		{"before=&beforeId=7", "before 无效：应为可解析的时间"},
		{"before=2026-09-23&beforeId=0", "beforeId 无效：应为正整数"},
		{"before=2026-09-23&beforeId=007", "beforeId 无效：应为正整数"},
		{"before=2026-09-23&beforeId=-3", "beforeId 无效：应为正整数"},
		{"before=2026-09-23&beforeId=1.5", "beforeId 无效：应为正整数"},
	}
	for _, tc := range cases {
		_, err := ParseRuntimeListQuery(mustQueryValues(t, tc.rawQuery))
		assertInvalidMessage(t, err, tc.want)
	}

	for _, tc := range []struct {
		rawQuery string
		want     string
	}{
		{"category=docker", "操作日志分类无效：docker"},
		{"category=", "操作日志分类无效："},
		{"category=nope", "操作日志分类无效：nope"},
		{"result=maybe", "操作结果无效：maybe"},
		{"status=ok", "登录状态无效：ok"},
	} {
		if tc.rawQuery == "status=ok" {
			_, err := ParseLoginListQuery(mustQueryValues(t, tc.rawQuery))
			assertInvalidMessage(t, err, tc.want)
			continue
		}
		_, err := ParseOperationListQuery(mustQueryValues(t, tc.rawQuery))
		assertInvalidMessage(t, err, tc.want)
	}

	// 合法枚举取值照常通过。
	if _, err := ParseOperationListQuery(mustQueryValues(t, "category=containers&result=failure")); err != nil {
		t.Errorf("合法枚举被拒：%v", err)
	}
	if _, err := ParseLoginListQuery(mustQueryValues(t, "status=success")); err != nil {
		t.Errorf("合法枚举被拒：%v", err)
	}
}
