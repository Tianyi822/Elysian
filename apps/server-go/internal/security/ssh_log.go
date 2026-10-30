package security

// ~/.Elysian/logs/sshd.log 的解析器（parseSshLog.ts 的 Go 等价物）：只认三类登录
// 事实行——Accepted publickey、Accepted password、Failed password，其余行跳过。
//
// 两种行形态都吃：syslog 守护转发的行带 `Sep 20 08:12:04 host sshd[123]:` 前缀，
// 时间戳（无年份）按注入的基准时间补全（月份大于基准月份视为跨年，取上一年）；
// 容器以 `sshd -E` 直写的行没有任何前缀（裸消息文本），at 为 null，由服务层用
// 「行 → 首次观察到的时间」内存映射稳定化（进程重启后清零是固有限制）。

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// SSH_LOG_TAIL_LINES 读取登录日志的行数上限：只取文件尾的最近段。
const SSH_LOG_TAIL_LINES = 2000

// ParsedLoginLine 解析出的一条登录事实；At 仅 syslog 前缀行有，裸行为 nil。
type ParsedLoginLine struct {
	// Source 原始日志行（trim 后）：无时间戳行的稳定时间映射键。
	Source string
	User   string
	IP     string
	Port   int
	Result string
	At     *string
}

// syslogPrefixRe `Sep 20 08:12:04 host sshd[123]:` syslog 前缀；捕获组 1-5 为时间、
// 组 6 为消息正文。
var syslogPrefixRe = regexp.MustCompile(`^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+\S+\s+(?:sshd|sshd-session)\[\d+\]:\s+(.*)$`)

// loginMessageRe 登录事实消息正文：`Accepted publickey for root from 1.2.3.4 port 51234 ssh2 …`。
var loginMessageRe = regexp.MustCompile(`^(Accepted\s+(?:publickey|password|keyboard-interactive(?:/pam)?)|Failed\s+(?:password|publickey|keyboard-interactive(?:/pam)?))\s+for\s+(?:invalid\s+user\s+)?(\S+)\s+from\s+(\S+)\s+port\s+(\d+)`)

// sshLogMonths syslog 月份缩写表（Jan..Dec）。
var sshLogMonths = []string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}

// TailLines 只保留文件尾最近 limit 行；limit 非正时返回空文本。
func TailLines(text string, limit int) string {
	if limit <= 0 {
		return ""
	}
	lines := strings.Split(text, "\n")
	if len(lines) <= limit {
		return text
	}
	return strings.Join(lines[len(lines)-limit:], "\n")
}

// ParseSshLog 解析日志全文（先按 SSH_LOG_TAIL_LINES 截尾），按日志书写顺序返回。
func ParseSshLog(text string, nowIso string) []ParsedLoginLine {
	return parseSshLogLines(TailLines(text, SSH_LOG_TAIL_LINES), nowIso)
}

func parseSshLogLines(text string, nowIso string) []ParsedLoginLine {
	now := parseIsoTime(nowIso)
	parsed := []ParsedLoginLine{}
	lines := strings.Split(text, "\n")

	for _, rawLine := range lines {
		source := strings.TrimSpace(rawLine)
		if source == "" {
			continue
		}
		// 先剥 syslog 前缀（有则取消息正文与时间），没有前缀则整行就是消息正文（sshd -E 裸行）。
		var isoAt *string
		if fields := strings.Fields(source); len(fields) >= 4 {
			if stamp, err := time.Parse(time.RFC3339Nano, fields[0]); err == nil && (strings.HasPrefix(fields[2], "sshd[") || strings.HasPrefix(fields[2], "sshd-session[")) {
				at := formatIsoMillis(stamp)
				isoAt = &at
				source = strings.Join(fields[3:], " ")
			}
		}
		prefixed := syslogPrefixRe.FindStringSubmatch(source)
		message := source
		if prefixed != nil {
			message = prefixed[6]
		}
		match := loginMessageRe.FindStringSubmatch(message)
		if match == nil {
			continue
		}
		eventText, user, ip, portText := match[1], match[2], match[3], match[4]

		at := isoAt
		if prefixed != nil {
			monthText, dayText := prefixed[1], prefixed[2]
			hourText, minuteText, secondText := prefixed[3], prefixed[4], prefixed[5]
			month := monthIndex(monthText)
			day, dayOk := jsParseInt(dayText)
			if month < 0 || !dayOk {
				continue
			}
			hour, _ := jsParseInt(hourText)
			minute, _ := jsParseInt(minuteText)
			second, _ := jsParseInt(secondText)
			// 跨年启发式：syslog 无年份，月份「超前」于基准时间说明这条属于上一年
			//（12 月的日志滚到 1 月还在写）。构造与窗口统计都用进程本地时。
			local := now.Local()
			year := local.Year()
			// JS 的 getMonth 0 起、Go 的 time.Month 1 起：统一换到 0 起再比较。
			if month > int(local.Month())-1 {
				year--
			}
			formatted := time.Date(year, time.Month(month+1), day, hour, minute, second, 0, time.Local).UTC().Format(isoMillisLayout)
			at = &formatted
		}

		port, _ := strconv.Atoi(portText)
		result := "failed"
		if strings.HasPrefix(eventText, "Accepted") {
			result = "succeeded"
		}
		parsed = append(parsed, ParsedLoginLine{
			Source: strings.TrimSpace(rawLine),
			User:   user,
			IP:     ip,
			Port:   port,
			Result: result,
			At:     at,
		})
	}

	return parsed
}

// SummarizeSshLog 三窗口统计：今日、昨日、近 7 天（含今日往前推 7 个自然日）；
// 窗口边界由注入的基准时间（进程本地时的当日零点）决定，基准之后的记录
// （时钟回拨样例）不计入任何窗口。
func SummarizeSshLog(records []SshLoginRecord, nowIso string) SshLoginStats {
	now := parseIsoTime(nowIso)
	local := now.Local()
	todayStart := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.Local)
	yesterdayStart := todayStart.AddDate(0, 0, -1)
	weekStart := todayStart.AddDate(0, 0, -6)
	nowMs := now.UnixMilli()
	stats := SshLoginStats{}

	for _, record := range records {
		at, ok := parseIsoTimeOk(record.At)
		if !ok {
			// JS 里 Date(非法).getTime() 为 NaN，一切比较为 false：不计入任何窗口。
			continue
		}
		atMs := at.UnixMilli()
		if atMs > nowMs {
			continue
		}
		result := "failed"
		if record.Result == "succeeded" {
			result = "succeeded"
		}
		switch {
		case atMs >= todayStart.UnixMilli():
			countLogin(&stats.Today, result)
			countLogin(&stats.Last7Days, result)
		case atMs >= yesterdayStart.UnixMilli():
			countLogin(&stats.Yesterday, result)
			countLogin(&stats.Last7Days, result)
		case atMs >= weekStart.UnixMilli():
			countLogin(&stats.Last7Days, result)
		}
	}

	return stats
}

// countLogin 按结果累加一次。
func countLogin(target *SshLoginCounts, result string) {
	if result == "succeeded" {
		target.Succeeded++
	} else {
		target.Failed++
	}
}

// monthIndex 月份缩写 → 0 起下标；未知返回 -1。
func monthIndex(text string) int {
	for i, m := range sshLogMonths {
		if m == text {
			return i
		}
	}
	return -1
}

// isoMillisLayout JS new Date().toISOString() 的等价格式（恒 3 位毫秒、UTC）。
const isoMillisLayout = "2006-01-02T15:04:05.000Z"

// parseIsoTime 解析 ISO 时间（面板自产的时间戳都符合该格式）。
func parseIsoTime(iso string) time.Time {
	t, _ := parseIsoTimeOk(iso)
	return t
}

// parseIsoTimeOk 解析 ISO 时间；无法解析返回 false（调用方按 JS NaN 语义处理）。
func parseIsoTimeOk(iso string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// daysSinceEpochUtc 自 1970-01-01（UTC）起的天数：shadow 的日期字段与今天都换算到
// 同一标尺再比较（负值向下取整）。
func daysSinceEpochUtc(iso string) int {
	t, ok := parseIsoTimeOk(iso)
	if !ok {
		return 0
	}
	return floorDiv(t.UnixMilli(), 86400000)
}

// floorDiv 向负无穷取整的整数除法。
func floorDiv(a, b int64) int {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return int(q)
}
