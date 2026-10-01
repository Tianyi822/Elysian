package logs

import (
	"encoding/json"
	"math"
	"strings"
	"unicode/utf16"
)

/*
 * 记录形状、净化与逐行解析（logRecords.ts 等价物，全纯函数；导入分片与写入口共用）。
 *
 * 净化面是整行：运行日志的 source/message 与操作日志的 action/target/summary/method/path
 * 在写入前全部过 normalizeSingleLine。
 *
 * JS 兼容点（logs 盘点风险 4）：
 *   - 空白类写死 JS \s 码位表（ECMAScript WhiteSpace+LineTerminator），不用 unicode.IsSpace
 *     （后者多认 U+0085 等）；
 *   - 截断长度按 JS UTF-16 code unit 计（增补平面字符算 2），jsSlice 可在代理对中间截断，
 *     孤立代理按 3 字节无效序列编码，UTF-8 字节数与 JS TextEncoder 的 U+FFFD 替换一致。
 */

// 字段上限（字符数，按 UTF-16 code unit）。
const (
	logMessageMaxLength  = 4096
	logSourceMaxLength   = 64
	logActionMaxLength   = 64
	logTargetMaxLength   = 64
	logSummaryMaxLength  = 200
	logMethodMaxLength   = 16
	logPathMaxLength     = 2048
	logIPMaxLength       = 64
	logLocationMaxLength = 32
	logUserAgentMaxLen   = 512
	// logRecordMaxBytes 单条记录的字节上限：超限的记录直接丢弃（导入路径则中止整份）。
	logRecordMaxBytes = 64 * 1024
	// logTruncationMarker 截断标记（UTF-16 长 6）。
	logTruncationMarker = "…（已截断）"
)

// isLineBreakingOrControl C0（U+0000–U+001F）、DEL（U+007F）、C1（U+0080–U+009F，含 U+0085）、
// U+2028/U+2029：JSON.stringify 不转义后两者而 readline 当行分隔符，必须一并替换。
func isLineBreakingOrControl(r rune) bool {
	if r <= 0x1F {
		return true
	}
	if r >= 0x7F && r <= 0x9F {
		return true
	}
	return r == 0x2028 || r == 0x2029
}

// isJSSpace JS \s 的码位全集（含 U+2028/U+2029——控制替换阶段已先处理，这里保持集合完整）。
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// trimJS 剥首尾 JS 空白（等价 String.prototype.trim 的集合）。
func trimJS(s string) string {
	return strings.TrimFunc(s, isJSSpace)
}

// jsLength 字符串的 UTF-16 code unit 数（等价 JS string.length）。
func jsLength(s string) int {
	return len(utf16.Encode([]rune(s)))
}

// jsSlice 按 UTF-16 code unit 截取（等价 String.prototype.slice(0, n)；可在代理对中间截断，
// 截出的孤立代理以 3 字节无效序列表示，UTF-8 度量上与 JS TextEncoder 的 U+FFFD 替换一致）。
func jsSlice(s string, n int) string {
	if n < 0 {
		n = 0
	}
	units := utf16.Encode([]rune(s))
	if len(units) <= n {
		return s
	}
	return string(utf16.Decode(units[:n]))
}

// NormalizeSingleLine 单行化：控制字符与行分隔符换成空格（不是删除），连续 JS 空白压成
// 一个空格后 trim，再按 maxLength（UTF-16 单位）截断；截断保留 maxLength−标记长 的正文并
// 追加标记，maxLength 小到装不下标记时退化为纯截断。
func NormalizeSingleLine(text string, maxLength int) string {
	var replaced strings.Builder
	replaced.Grow(len(text))
	for _, r := range text {
		if isLineBreakingOrControl(r) {
			replaced.WriteRune(' ')
		} else {
			replaced.WriteRune(r)
		}
	}
	collapsed := collapseJSSpaces(replaced.String())
	normalized := trimJS(collapsed)
	if jsLength(normalized) <= maxLength {
		return normalized
	}
	if maxLength <= jsLength(logTruncationMarker) {
		return jsSlice(normalized, maxLength)
	}
	return jsSlice(normalized, maxLength-jsLength(logTruncationMarker)) + logTruncationMarker
}

// collapseJSSpaces 连续 JS 空白压成一个空格。
func collapseJSSpaces(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	inSpace := false
	for _, r := range s {
		if isJSSpace(r) {
			if !inSpace {
				b.WriteRune(' ')
				inSpace = true
			}
			continue
		}
		inSpace = false
		b.WriteRune(r)
	}
	return b.String()
}

// UTF8ByteLength 单行文本的 UTF-8 字节数（硬闸的度量口径）。
func UTF8ByteLength(text string) int {
	return len([]byte(text))
}

// isRecordOversize 单行是否超过单条记录上限。
func isRecordOversize(line string) bool {
	return UTF8ByteLength(line) > logRecordMaxBytes
}

// ---------- 逐行 JSON 解析（导入与读回共用判据；坏行返回零值+false） ----------

// asJSONObject 解析出的 JSON 对象（非对象与坏 JSON 都返回 nil）。
func asJSONObject(line string) map[string]any {
	var value any
	if err := json.Unmarshal([]byte(line), &value); err != nil {
		return nil
	}
	if m, ok := value.(map[string]any); ok {
		return m
	}
	return nil
}

// isISOTimestamp at 判据：非空字符串且可被 Date.parse 量级的解析器接受。
func isISOTimestamp(value any) bool {
	s, ok := value.(string)
	if !ok || s == "" {
		return false
	}
	return dateParses(s)
}

// isJSONInteger JS Number.isInteger 判据（JSON 数字统一解成 float64）。
func isJSONInteger(value any) bool {
	f, ok := value.(float64)
	if !ok {
		return false
	}
	if math.IsInf(f, 0) || math.IsNaN(f) {
		return false
	}
	return f == math.Trunc(f)
}

// isJSONNumberOrString 取值器共用的「数字或字符串」判据。
func isJSONNumberOrString(value any) bool {
	switch value.(type) {
	case float64, string:
		return true
	default:
		return false
	}
}

// jsStringOf JS String(v)：数字走最短往返表示，字符串原样。
func jsStringOf(value any) (string, bool) {
	switch v := value.(type) {
	case string:
		return v, true
	case float64:
		return formatJSNumber(v), true
	default:
		return "", false
	}
}

// formatJSNumber JS Number → string 的常用子集（最短往返、整数无小数点；端口等小整数完全一致）。
func formatJSNumber(f float64) string {
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconvFormatInt(f)
	}
	return strconvFormatGeneral(f)
}

// runtimeLogRecord 已校验的运行日志记录。
type runtimeLogRecord struct {
	at      string
	seq     float64
	level   string
	source  string
	message string
}

// loginLogRecord 已校验的登录日志记录。
type loginLogRecord struct {
	at        string
	seq       float64
	ip        string
	location  string
	userAgent string
	status    string
}

// operationLogRecord 已校验的操作日志记录。
type operationLogRecord struct {
	at         string
	seq        float64
	category   string
	action     string
	target     *string
	result     string
	httpStatus *float64
	method     *string
	path       *string
	summary    string
}

// parseRuntimeLogLine 解析运行日志的一行；坏行与形状不合法返回 nil。
func parseRuntimeLogLine(line string) *runtimeLogRecord {
	value := asJSONObject(line)
	if value == nil {
		return nil
	}
	if !isISOTimestamp(value["at"]) {
		return nil
	}
	if !isJSONInteger(value["seq"]) {
		return nil
	}
	level, ok := value["level"].(string)
	if !ok || !containsString(platformLogLevels, level) {
		return nil
	}
	source, sourceOK := value["source"].(string)
	message, messageOK := value["message"].(string)
	if !sourceOK || !messageOK {
		return nil
	}
	return &runtimeLogRecord{
		at:      value["at"].(string),
		seq:     value["seq"].(float64),
		level:   level,
		source:  source,
		message: message,
	}
}

// parseLoginLogLine 解析登录日志的一行；坏行与形状不合法返回 nil。
func parseLoginLogLine(line string) *loginLogRecord {
	value := asJSONObject(line)
	if value == nil {
		return nil
	}
	if !isISOTimestamp(value["at"]) {
		return nil
	}
	if !isJSONInteger(value["seq"]) {
		return nil
	}
	ip, ipOK := value["ip"].(string)
	location, locationOK := value["location"].(string)
	userAgent, userAgentOK := value["userAgent"].(string)
	if !ipOK || !locationOK || !userAgentOK {
		return nil
	}
	status, ok := value["status"].(string)
	if !ok || !containsString(loginLogStatuses, status) {
		return nil
	}
	return &loginLogRecord{
		at:        value["at"].(string),
		seq:       value["seq"].(float64),
		ip:        ip,
		location:  location,
		userAgent: userAgent,
		status:    status,
	}
}

// parseOperationLogLine 解析操作日志的一行；坏行与形状不合法返回 nil（多余字段丢弃）。
func parseOperationLogLine(line string) *operationLogRecord {
	value := asJSONObject(line)
	if value == nil {
		return nil
	}
	if !isISOTimestamp(value["at"]) {
		return nil
	}
	if !isJSONInteger(value["seq"]) {
		return nil
	}
	category, ok := value["category"].(string)
	if !ok || !containsString(operationLogCategories, category) {
		return nil
	}
	action, actionOK := value["action"].(string)
	if !actionOK {
		return nil
	}
	target, targetOK := jsonNullableString(value["target"])
	if !targetOK {
		return nil
	}
	result, resultOK := value["result"].(string)
	if !resultOK || !containsString(operationLogOutcomes, result) {
		return nil
	}
	httpStatus, httpStatusOK := jsonNullableInteger(value["httpStatus"])
	if !httpStatusOK {
		return nil
	}
	method, methodOK := jsonNullableString(value["method"])
	if !methodOK {
		return nil
	}
	path, pathOK := jsonNullableString(value["path"])
	if !pathOK {
		return nil
	}
	summary, summaryOK := value["summary"].(string)
	if !summaryOK {
		return nil
	}
	return &operationLogRecord{
		at:         value["at"].(string),
		seq:        value["seq"].(float64),
		category:   category,
		action:     action,
		target:     target,
		result:     result,
		httpStatus: httpStatus,
		method:     method,
		path:       path,
		summary:    summary,
	}
}

// jsonNullableString 字符串或 null。
func jsonNullableString(value any) (*string, bool) {
	switch v := value.(type) {
	case nil:
		return nil, true
	case string:
		return &v, true
	default:
		return nil, false
	}
}

// jsonNullableInteger 整数或 null（JS Number.isInteger 判据）。
func jsonNullableInteger(value any) (*float64, bool) {
	switch v := value.(type) {
	case nil:
		return nil, true
	case float64:
		if isJSONInteger(v) {
			return &v, true
		}
		return nil, false
	default:
		return nil, false
	}
}

// logRecordId 记录 id：`<at>#<seq>`（分片时代出口，导入判据共用）。
func logRecordId(at string, seq float64) string {
	return at + "#" + formatJSNumber(seq)
}
