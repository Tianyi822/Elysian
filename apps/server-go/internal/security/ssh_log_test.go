package security

// 登录日志解析与三窗口统计的对等测试（对齐 parseSshLog.test.ts，security 盘点 §8）。
// 时间期望值全部用 time.Local 计算（TS 版用进程本地时），与容器 TZ 无关。

import (
	"strings"
	"testing"
	"time"
)

func localIso(year int, month time.Month, day, hour, minute, second int) string {
	return time.Date(year, month, day, hour, minute, second, 0, time.Local).UTC().Format(isoMillisLayout)
}

func TestParseSshLog三类事实行与无关行(t *testing.T) {
	text := "Sep 20 08:12:04 host sshd[123]: Accepted publickey for root from 1.2.3.4 port 51234 ssh2: ED25519 SHA256:xx\n" +
		"Sep 20 08:13:05 host sshd[123]: Accepted password for ops from 5.6.7.8 port 41000\n" +
		"Sep 20 08:14:06 host sshd[123]: Failed password for invalid user admin from 9.9.9.9 port 2200 ssh2\n" +
		"Sep 20 08:15:07 host sshd[123]: Received disconnect from 1.2.3.4 port 51234:11: disconnected by user\n" +
		"Sep 20 08:16:08 host sshd[124]: subsystem request for sftp\n"
	parsed := ParseSshLog(text, "2026-09-20T10:00:00.000Z")
	if len(parsed) != 3 {
		t.Fatalf("应解析出 3 条事实行，得 %d", len(parsed))
	}
	if parsed[0].Result != "succeeded" || parsed[0].User != "root" || parsed[0].IP != "1.2.3.4" || parsed[0].Port != 51234 {
		t.Errorf("第一条解析错：%+v", parsed[0])
	}
	if parsed[1].Result != "succeeded" || parsed[1].User != "ops" {
		t.Errorf("第二条解析错：%+v", parsed[1])
	}
	if parsed[2].Result != "failed" || parsed[2].User != "admin" {
		t.Errorf("invalid user 前缀应计入 failed 且取真实用户名：%+v", parsed[2])
	}
	if parsed[0].At == nil || *parsed[0].At != localIso(2026, time.September, 20, 8, 12, 4) {
		t.Errorf("syslog 时间补全错：%v", parsed[0].At)
	}
}

func TestParseSshLog跨年启发式(t *testing.T) {
	// 基准一月，日志十二月：月份超前于基准，取上一年。
	parsed := ParseSshLog("Dec 30 23:59:59 host sshd[1]: Failed password for root from 1.1.1.1 port 1 ssh2\n", "2027-01-02T00:00:00.000Z")
	if len(parsed) != 1 || parsed[0].At == nil {
		t.Fatalf("跨年行应解析：%+v", parsed)
	}
	if want := localIso(2026, time.December, 30, 23, 59, 59); *parsed[0].At != want {
		t.Errorf("跨年补全错：got %s want %s", *parsed[0].At, want)
	}
	// 同年内的月份不回退。
	parsed = ParseSshLog("Mar 01 00:00:00 host sshd[1]: Failed password for root from 1.1.1.1 port 1 ssh2\n", "2026-09-20T00:00:00.000Z")
	if want := localIso(2026, time.March, 1, 0, 0, 0); *parsed[0].At != want {
		t.Errorf("同年补全错：got %s want %s", *parsed[0].At, want)
	}
}

func TestParseSshLog裸行与混合形态(t *testing.T) {
	bare := "Accepted publickey for root from 1.2.3.4 port 51234 ssh2: ED25519 SHA256:xx"
	text := bare + "\n" +
		"Sep 20 08:12:04 host sshd[123]: Failed password for ops from 5.6.7.8 port 41000 ssh2\n"
	parsed := ParseSshLog(text, "2026-09-20T10:00:00.000Z")
	if len(parsed) != 2 {
		t.Fatalf("混合形态应解析 2 条：%d", len(parsed))
	}
	if parsed[0].At != nil {
		t.Errorf("sshd -E 裸行 at 应为 null：%v", parsed[0].At)
	}
	if parsed[0].Source != bare {
		t.Errorf("source 应为 trim 后的原始行：%q", parsed[0].Source)
	}
	if parsed[1].At == nil {
		t.Errorf("syslog 行应有时间")
	}
}

func TestParseSshLog两千行截尾(t *testing.T) {
	// 2001 行事实：只有最后 2000 行进入解析，id 顺序敏感地移位。
	var b []byte
	line := "Failed password for u from 1.1.1.1 port 1 ssh2\n"
	for i := 0; i < 2001; i++ {
		b = append(b, line...)
	}
	// 末尾换行产物不算内容行：2001 条内容 + 结尾空串 → split 出 2002 段，
	// 截尾保留最后 2000 段 = 1999 条内容行 + 空串（与 TS slice 语义一致）。
	// 这里去掉末尾换行让断言落在整 2000 条上。
	text := strings.TrimSuffix(string(b), "\n")
	parsed := ParseSshLog(text, "2026-09-20T10:00:00.000Z")
	if len(parsed) != 2000 {
		t.Errorf("应只保留 2000 行，得 %d", len(parsed))
	}
	// split 得 [a b c ""]，slice(len-2) = [c ""]，join 得 "c\n"（同 TS 语义）。
	if TailLines("a\nb\nc\n", 2) != "c\n" {
		t.Errorf("tailLines 截尾失败：%q", TailLines("a\nb\nc\n", 2))
	}
	if TailLines("a\nb", 5) != "a\nb" {
		t.Errorf("tailLines 不超限时原样：%q", TailLines("a\nb", 5))
	}
	if TailLines("a\nb", 0) != "" {
		t.Errorf("tailLines 非正上限应返回空")
	}
}

func TestSummarizeSshLog三窗口统计(t *testing.T) {
	now := "2026-09-20T10:00:00.000Z"
	local := parseIsoTime(now).Local()
	todayStart := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.Local)
	mk := func(offset time.Duration, result string) SshLoginRecord {
		at := todayStart.Add(offset).UTC().Format(isoMillisLayout)
		return SshLoginRecord{ID: "x", At: at, Result: result}
	}
	records := []SshLoginRecord{
		mk(1*time.Hour, "succeeded"),                // 今日
		mk(1*time.Hour, "failed"),                   // 今日
		mk(-2*time.Hour, "succeeded"),               // 昨日
		mk(-26*time.Hour, "failed"),                 // 仅 7 天窗（前天）
		mk(-7*24*time.Hour-1*time.Second, "failed"), // 7 天窗外，不计
		{ID: "future", At: todayStart.Add(12 * time.Hour).UTC().Format(isoMillisLayout), Result: "failed"}, // 基准之后不计
	}
	stats := SummarizeSshLog(records, now)
	if stats.Today.Succeeded != 1 || stats.Today.Failed != 1 {
		t.Errorf("今日统计错：%+v", stats.Today)
	}
	if stats.Yesterday.Succeeded != 1 || stats.Yesterday.Failed != 0 {
		t.Errorf("昨日统计错：%+v", stats.Yesterday)
	}
	if stats.Last7Days.Succeeded != 2 || stats.Last7Days.Failed != 2 {
		t.Errorf("近 7 天统计错（今日昨日都计入）：%+v", stats.Last7Days)
	}
}

func TestSummarizeSshLog窗口边界随基准时间变化(t *testing.T) {
	// 同一时刻的记录在不同基准日下落入不同窗口。
	at := "2026-09-19T12:00:00.000Z"
	stats := SummarizeSshLog([]SshLoginRecord{{At: at, Result: "succeeded"}}, "2026-09-20T10:00:00.000Z")
	if stats.Yesterday.Succeeded != 1 || stats.Today.Succeeded != 0 {
		t.Errorf("9 月 19 日记录在 9 月 20 日基准下应计入昨日：%+v", stats)
	}
	stats = SummarizeSshLog([]SshLoginRecord{{At: at, Result: "succeeded"}}, "2026-09-19T13:00:00.000Z")
	if stats.Today.Succeeded != 1 || stats.Yesterday.Succeeded != 0 {
		t.Errorf("同日基准应计入今日：%+v", stats)
	}
}
