package logs

import (
	"fmt"
	"strconv"
	"time"
)

// timeValue 时刻别名：全部「当前时间」经注入的 now() 取，测试可替换。
type timeValue = time.Time

/*
 * 契约常量与报告形状（@elysian/contracts 的 logs 两模块等价物，go-plan §4.4 预定落
 * internal/contract，骨架尚未预置，本域内先建私有副本；JSON 键序即结构体声明序，
 * 全部输出经 shared.MarshalJSON（不转义 <>&），对齐 TS JSON.stringify 的插入序。
 */

// 平台日志类别（登录日志单独记账，不进合计字节与清空端点）。
const (
	categoryRuntime   = "runtime"
	categoryOperation = "operation"
	categoryLogin     = "login"
)

// platformLogCategoryLabels 类别中文标签（清空留痕与巡检摘要共用）。
var platformLogCategoryLabels = map[string]string{
	categoryRuntime:   "运行日志",
	categoryOperation: "操作日志",
}

// platformLogLevels 运行日志级别取值。
var platformLogLevels = []string{"debug", "info", "warning", "error"}

// operationLogCategories 操作日志分类全集（校验与导入判据共用）。
var operationLogCategories = []string{
	"security", "files", "database", "terminals", "logs", "containers", "websites", "auth",
}

// operationLogOutcomes 操作结果取值。
var operationLogOutcomes = []string{"success", "failure"}

// loginLogStatuses 登录状态取值。
var loginLogStatuses = []string{"success", "failure"}

// containsString 小工具：枚举表包含判定。
func containsString(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}

// logRetentionPolicy 单类别的保留策略。
type logRetentionPolicy struct {
	retentionDays int
	maxTotalBytes int64
}

// logRetentionPolicies 契约 LOG_RETENTION_POLICIES：runtime 7 天/256 MiB、operation 30 天/64 MiB。
var logRetentionPolicies = map[string]logRetentionPolicy{
	categoryRuntime:   {retentionDays: 7, maxTotalBytes: 256 * 1024 * 1024},
	categoryOperation: {retentionDays: 30, maxTotalBytes: 64 * 1024 * 1024},
}

// loginRetentionPolicy 登录日志保留（与 DEFAULT_LOGIN_POLICY / LOGIN_RETENTION_POLICY 同值）。
var loginRetentionPolicy = logRetentionPolicy{retentionDays: 30, maxTotalBytes: 16 * 1024 * 1024}

// retentionPolicyOf 巡检类别 → 策略。
func retentionPolicyOf(category string) logRetentionPolicy {
	if category == categoryLogin {
		return loginRetentionPolicy
	}
	return logRetentionPolicies[category]
}

// sweepCategoryLabel 巡检摘要里的类别标签：login → 登录日志，其余用契约标签表。
func sweepCategoryLabel(category string) string {
	if category == categoryLogin {
		return "登录日志"
	}
	return platformLogCategoryLabels[category]
}

// logEntryFetchLimit 单次读取最多返回的条目数（limit 钳制上限）。
const logEntryFetchLimit = 1000

// logClearableCategories 允许从界面清空的类别（清空路由由此推导）。
var logClearableCategories = []string{categoryRuntime, categoryOperation}

// RuntimeLogEntry 运行日志条目（界面形状）。
type RuntimeLogEntry struct {
	ID      string `json:"id"`
	At      string `json:"at"`
	Level   string `json:"level"`
	Source  string `json:"source"`
	Message string `json:"message"`
}

// OperationLogEntry 操作日志条目（界面形状）；可空字段 null 原样返回。
type OperationLogEntry struct {
	ID         string  `json:"id"`
	At         string  `json:"at"`
	Category   string  `json:"category"`
	Action     string  `json:"action"`
	Target     *string `json:"target"`
	Summary    string  `json:"summary"`
	Result     string  `json:"result"`
	Method     *string `json:"method"`
	Path       *string `json:"path"`
	HTTPStatus *int64  `json:"httpStatus"`
}

// LoginLogEntry 登录日志条目；注意字段名是 time（不是 at）。
type LoginLogEntry struct {
	ID        string `json:"id"`
	IP        string `json:"ip"`
	Location  string `json:"location"`
	UserAgent string `json:"userAgent"`
	Status    string `json:"status"`
	Time      string `json:"time"`
}

// LogStorageStats 日志存储统计：字节/行数是全库（runtime+operation 两表合计），
// 只有 lastSweepAt/trimmedBySize 按类别取；登录日志不计入。
type LogStorageStats struct {
	TotalBytes        int64   `json:"totalBytes"`
	RuntimeBytes      int64   `json:"runtimeBytes"`
	OperationBytes    int64   `json:"operationBytes"`
	RuntimeRowCount   int64   `json:"runtimeRowCount"`
	OperationRowCount int64   `json:"operationRowCount"`
	RowCount          int64   `json:"rowCount"`
	OldestAt          *string `json:"oldestAt"`
	LastSweepAt       *string `json:"lastSweepAt"`
	TrimmedBySize     bool    `json:"trimmedBySize"`
	DroppedRecords    int64   `json:"droppedRecords"`
	FailedWrites      int64   `json:"failedWrites"`
}

// RuntimeLogListReport 运行日志列表响应。
type RuntimeLogListReport struct {
	Entries      []RuntimeLogEntry `json:"entries"`
	Total        int64             `json:"total"`
	Truncated    bool              `json:"truncated"`
	SkippedLines int64             `json:"skippedLines"`
	SkippedFiles int64             `json:"skippedFiles"`
	Storage      LogStorageStats   `json:"storage"`
}

// OperationLogListReport 操作日志列表响应。
type OperationLogListReport struct {
	Entries      []OperationLogEntry `json:"entries"`
	Total        int64               `json:"total"`
	Truncated    bool                `json:"truncated"`
	SkippedLines int64               `json:"skippedLines"`
	SkippedFiles int64               `json:"skippedFiles"`
	Storage      LogStorageStats     `json:"storage"`
}

// LoginLogListReport 登录日志列表响应（无 storage 字段）。
type LoginLogListReport struct {
	Entries      []LoginLogEntry `json:"entries"`
	Total        int64           `json:"total"`
	Truncated    bool            `json:"truncated"`
	SkippedLines int64           `json:"skippedLines"`
	SkippedFiles int64           `json:"skippedFiles"`
}

// LogClearReport 清空结果：已删除的事实。
type LogClearReport struct {
	Category   string  `json:"category"`
	RowCount   int64   `json:"rowCount"`
	TotalBytes int64   `json:"totalBytes"`
	OldestAt   *string `json:"oldestAt"`
	ClearedAt  string  `json:"clearedAt"`
}

const (
	bytesPerKB = 1024
	bytesPerMB = 1024 * 1024
	bytesPerGB = 1024 * 1024 * 1024
)

// logByteDivisor 量级 → 除数。
func logByteDivisor(scale int) int64 {
	switch scale {
	case 0:
		return bytesPerKB
	case 1:
		return bytesPerMB
	default:
		return bytesPerGB
	}
}

// logByteUnit 量级 → 单位。
func logByteUnit(scale int) string {
	switch scale {
	case 0:
		return "KB"
	case 1:
		return "MB"
	default:
		return "GB"
	}
}

// toFixed2 等价 JS Number.prototype.toFixed(2) 的十进制文本（对 bytes/1024^n 的值
// 不会出现二进制精确半数 ties，%.2f 与 toFixed 结论一致，见测试）。
func toFixed2(value float64) string {
	return fmt.Sprintf("%.2f", value)
}

// FormatLogBytes 日志体积的中文文案（契约 formatLogBytes 的唯一等价物）：
// 先按量级选单位（<1 MiB → KB；<1 GiB → MB；否则 GB），数值一律两位小数；
// 若显示值 ≥ 1024.00 则逐级进位，直到 < 1024.00 或已是 GB；非正数 → 0.00 KB。
func FormatLogBytes(bytes int64) string {
	if bytes <= 0 {
		return "0.00 " + logByteUnit(0)
	}
	scale := 0
	if bytes >= bytesPerGB {
		scale = 2
	} else if bytes >= bytesPerMB {
		scale = 1
	}
	text := toFixed2(float64(bytes) / float64(logByteDivisor(scale)))
	// 进位看显示值：1023.999 KB 显示成 1024.00 时也要进到 MB。
	for scale < 2 {
		shown, err := strconv.ParseFloat(text, 64)
		if err != nil || shown < 1024 {
			break
		}
		scale++
		text = toFixed2(float64(bytes) / float64(logByteDivisor(scale)))
	}
	return text + " " + logByteUnit(scale)
}

// isoTimeLayout 服务端时钟的 ISO 文本布局（对齐 new Date().toISOString()：恒 UTC、毫秒三位、Z 后缀）。
const isoTimeLayout = "2006-01-02T15:04:05.000Z07:00"

// isoTime 服务端时刻 → ISO 文本（唯一出口）。
func isoTime(t timeValue) string {
	return t.UTC().Format(isoTimeLayout)
}
