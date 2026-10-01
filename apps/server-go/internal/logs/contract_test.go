package logs

import "testing"

// FormatLogBytes 的取值锚点全部抄自契约 JSDoc（platformLogs.ts:225-227）与
// logs 盘点 §4.3；数值与单位逐字断言。
func TestFormatLogBytes(t *testing.T) {
	cases := []struct {
		bytes int64
		want  string
	}{
		{0, "0.00 KB"},
		{-5, "0.00 KB"},
		{1023, "1.00 KB"},
		{1048000, "1023.44 KB"},
		{1048575, "1.00 MB"},
		{1048576, "1.00 MB"},
		{13713, "13.39 KB"},
		{1073741823, "1.00 GB"},
		{1073741824, "1.00 GB"},
		{2147483648, "2.00 GB"},
		{512, "0.50 KB"},
	}
	for _, tc := range cases {
		if got := FormatLogBytes(tc.bytes); got != tc.want {
			t.Errorf("FormatLogBytes(%d) = %q, want %q", tc.bytes, got, tc.want)
		}
	}
}

// 保留策略与常量表锚点（契约 LOG_RETENTION_POLICIES / LOG_CLEARABLE_CATEGORIES）。
func TestRetentionPoliciesAndClearableCategories(t *testing.T) {
	if got := logRetentionPolicies[categoryRuntime]; got.retentionDays != 7 || got.maxTotalBytes != 256*1024*1024 {
		t.Errorf("runtime 保留策略 = %+v", got)
	}
	if got := logRetentionPolicies[categoryOperation]; got.retentionDays != 30 || got.maxTotalBytes != 64*1024*1024 {
		t.Errorf("operation 保留策略 = %+v", got)
	}
	if got := loginRetentionPolicy; got.retentionDays != 30 || got.maxTotalBytes != 16*1024*1024 {
		t.Errorf("login 保留策略 = %+v", got)
	}
	if len(logClearableCategories) != 2 || logClearableCategories[0] != "runtime" || logClearableCategories[1] != "operation" {
		t.Errorf("可清空类别 = %v", logClearableCategories)
	}
	if logEntryFetchLimit != 1000 {
		t.Errorf("LOG_ENTRY_FETCH_LIMIT = %d", logEntryFetchLimit)
	}
}

// sweepCategoryLabel：login 特判「登录日志」，其余用契约标签表。
func TestSweepCategoryLabel(t *testing.T) {
	cases := map[string]string{
		categoryLogin:     "登录日志",
		categoryRuntime:   "运行日志",
		categoryOperation: "操作日志",
	}
	for category, want := range cases {
		if got := sweepCategoryLabel(category); got != want {
			t.Errorf("sweepCategoryLabel(%s) = %q, want %q", category, got, want)
		}
	}
}
