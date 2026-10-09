// logger.go 对应 TS core/src/logger.ts。TS 的可调用服务（createCallable +
// [symbols.invoke]）在 Go 显式化为 Caller 接口的 InvokeC：名字解析链按方案
// 2.5——显式 name > InterceptAll("logger") 合并配置里的 name >
// hyphenate(caller.DefSite().Fiber().Name())；intercept 沿 caller 链（use
// site 链，外层 intercept 因此能覆盖服务派生名），fiber 归属取 DefSite。
// WeakRef<Fiber> 改强引用（差异清单第 6 条）。
package kardia

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// LoggerLevel 对应 TS LoggerLevel 枚举（数值是协议）。
type LoggerLevel int

const (
	LoggerError LoggerLevel = iota
	LoggerWarn
	LoggerInfo
	LoggerDebug
)

// LoggerType 对应 TS LoggerType。
type LoggerType string

const (
	LoggerTypeError LoggerType = "error"
	LoggerTypeWarn  LoggerType = "warn"
	LoggerTypeInfo  LoggerType = "info"
	LoggerTypeDebug LoggerType = "debug"
)

// Message 对应 TS Message（logger.ts:25-33）。
type Message struct {
	SN    uint64
	TS    int64 // 毫秒，取自 ctx 时钟
	Name  string
	Type  LoggerType
	Level int
	Args  []any
	Fiber *Fiber
	Meta  map[string]any
}

// Formatter 对应 TS Formatter：把单个值转换为可拼接的展示形态。
type Formatter func(value any, exporter Exporter, message *Message) any

// Exporter 接收独立消息快照；Export 可并发调用，实现负责自身输出接缝的同步。
type Exporter interface {
	Export(message *Message)
	// Options 返回独立配置快照；实现必须支持并发读取。
	Options() *ExporterConfig
}

// ExporterConfig 对应 TS Exporter 的配置字段。零值语义：Colors 0（无色，
// TS false）、MaxLength nil（按默认 10240 处理）、Levels/Formatters nil。
type ExporterConfig struct {
	Colors     int  // 0-3；TS false → 0
	MaxLength  *int // nil 为默认 10240，显式 0 截断全部字符
	Levels     map[string]int
	Formatters map[string]Formatter
}

// ExporterBase 保存并发安全的配置；调用方通过 SetOptions 更新，通过 Options 读取快照。
type ExporterBase struct {
	mu     sync.RWMutex
	config ExporterConfig
}

func (b *ExporterBase) Options() *ExporterConfig {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return cloneExporterConfig(&b.config)
}

func (b *ExporterBase) SetOptions(config ExporterConfig) {
	snapshot := cloneExporterConfig(&config)
	b.mu.Lock()
	b.config = *snapshot
	b.mu.Unlock()
}

func cloneExporterConfig(config *ExporterConfig) *ExporterConfig {
	if config == nil {
		return nil
	}
	clone := *config
	if config.MaxLength != nil {
		n := *config.MaxLength
		clone.MaxLength = &n
	}
	if config.Levels != nil {
		clone.Levels = make(map[string]int, len(config.Levels))
		for key, value := range config.Levels {
			clone.Levels[key] = value
		}
	}
	if config.Formatters != nil {
		clone.Formatters = make(map[string]Formatter, len(config.Formatters))
		for key, value := range config.Formatters {
			clone.Formatters[key] = value
		}
	}
	return &clone
}

// colors16 与 colors256 对应 TS 的 c16/c256 色表（logger.ts:150-157，协议值照抄）。
var colors16 = []int{6, 2, 3, 4, 5, 1}

var colors256 = []int{
	20, 21, 26, 27, 32, 33, 38, 39, 40, 41, 42, 43, 44, 45, 56, 57, 62,
	63, 68, 69, 74, 75, 76, 77, 78, 79, 80, 81, 92, 93, 98, 99, 112, 113,
	129, 134, 135, 148, 149, 160, 161, 162, 163, 164, 165, 166, 167, 168,
	169, 170, 171, 172, 173, 178, 179, 184, 185, 196, 197, 198, 199, 200,
	201, 202, 203, 204, 205, 206, 207, 208, 209, 214, 215, 220, 221,
}

// defaultFormatters 对应 TS defaultFormatters（logger.ts:43-54）。
// d/i 为取整、f 为数值、o/O 为 JSON 化、c 清样式、C 按消息名着色。
var defaultFormatters = map[string]Formatter{
	"s": func(value any, _ Exporter, _ *Message) any { return fmt.Sprint(value) },
	"d": formatIntLike,
	"i": formatIntLike,
	"f": func(value any, _ Exporter, _ *Message) any { return formatFloat(toNumber(value)) },
	"o": formatJSONObject,
	"O": formatJSONObject,
	"c": func(any, Exporter, *Message) any { return "" },
	"C": func(value any, exporter Exporter, message *Message) any {
		colors := 0
		if opts := exporterOptions(exporter); opts != nil {
			colors = opts.Colors
		}
		return LoggerColor(exporter, LoggerCode(message.Name, colors), value, "")
	},
}

// LoggerColor 对应 TS Logger.color（logger.ts:70-73）：无色（colors=0）时
// 返回值的字符串形态；否则生成 ANSI 颜色序列，code<8 为基本色
// （"3<code>"），否则 256 色（"38;5;<code>"）；colors>=2 时附带装饰串。
func LoggerColor(exporter Exporter, code int, value any, decoration string) string {
	colors := 0
	if opts := exporterOptions(exporter); opts != nil {
		colors = opts.Colors
	}
	if colors == 0 {
		return fmt.Sprint(value)
	}
	var b strings.Builder
	b.WriteString("\u001b[")
	if code < 8 {
		b.WriteString("3")
		b.WriteString(strconv.Itoa(code))
	} else {
		b.WriteString("38;5;")
		b.WriteString(strconv.Itoa(code))
	}
	if colors >= 2 {
		b.WriteString(decoration)
	}
	b.WriteString("m")
	b.WriteString(fmt.Sprint(value))
	b.WriteString("\u001b[0m")
	return b.String()
}

// LoggerCode 对应 TS Logger.code（logger.ts:75-83）：哈希算法照搬
// （（hash<<3）-hash + 字符码 + 13，JS 位运算为 32 位有符号环绕，Go 以
// int32 复刻；字符按 rune 迭代，服务名均为 ASCII，与 UTF-16 码元一致）。
// level 0 对应 TS 的 !level（无色表），1 取 colors16，>=2 取 colors256。
func LoggerCode(name string, level int) int {
	var hash int32
	for _, ch := range name {
		hash = (hash << 3) - hash + int32(ch) + 13
	}
	var colors []int
	switch {
	case level == 0:
		colors = nil
	case level >= 2:
		colors = colors256
	default:
		colors = colors16
	}
	if len(colors) == 0 {
		return 0
	}
	m := int64(hash)
	if m < 0 {
		m = -m
	}
	return colors[m%int64(len(colors))]
}

// LoggerFormat 对应 TS Logger.format（logger.ts:85-117）：%s/%d/%i/%f/%o/%O/
// %c/%C/%% 替换、剩余参数追加（对象经 o formatter）、按行截断到 maxLength
// （超长加 "..."）。首参数为 error 时改写为其文案并前置 %s；非字符串时
// 前置 %o。TS 的 args[0].stack 无 Go 等价（差异清单第 5 条），取 Error()。
func LoggerFormat(exporter Exporter, message *Message) string {
	cfg := exporterOptions(exporter)
	args := append([]any(nil), message.Args...)
	if len(args) > 0 {
		if err, ok := args[0].(error); ok {
			args[0] = err.Error()
			args = append([]any{"%s"}, args...)
		} else if _, ok := args[0].(string); !ok {
			args = append([]any{"%o"}, args...)
		}
	}
	var format string
	if len(args) > 0 {
		format, _ = args[0].(string)
		args = args[1:]
	}
	var b strings.Builder
	i := 0
	for i < len(format) {
		ch := format[i]
		if ch == '%' && i+1 < len(format) {
			next := format[i+1]
			if next == '%' {
				b.WriteByte('%')
				i += 2
				continue
			}
			if isASCIILetter(next) {
				formatter := lookupFormatter(cfg, next)
				if formatter != nil {
					var value any
					if len(args) > 0 {
						value = args[0]
						args = args[1:]
					}
					b.WriteString(fmt.Sprint(formatter(value, exporter, message)))
					i += 2
					continue
				}
				b.WriteString(format[i : i+2])
				i += 2
				continue
			}
		}
		b.WriteByte(ch)
		i++
	}
	oFormatter := lookupFormatter(cfg, 'o')
	for _, arg := range args {
		if arg != nil && isObjectLike(arg) && oFormatter != nil {
			arg = oFormatter(arg, exporter, message)
		}
		b.WriteString(" ")
		b.WriteString(fmt.Sprint(arg))
	}
	maxLength := 10240
	if cfg != nil && cfg.MaxLength != nil {
		maxLength = *cfg.MaxLength
	}
	lines := strings.Split(b.String(), "\n")
	for idx, line := range lines {
		line = strings.TrimSuffix(line, "\r")
		lines[idx] = truncateLine(line, maxLength)
	}
	return strings.Join(lines, "\n")
}

// Logger 对应 TS Logger 实例（name/level/meta + 四方法）。hasLevel 区分
// 「显式 level=0」与「未设置」（Go int 零值歧义；TS 未设置走 ?? INFO）。
type Logger struct {
	name     string
	level    int
	hasLevel bool
	fiber    *Fiber
	service  *LoggerService
}

// Error 输出错误级日志；单个 error 参数按 cause/聚合递归展开
// （logger.ts:127-136）：有 cause 时先展开 cause 再继续输出原错误；
// *AggregateError 展开各子错误后不再输出聚合本身。
func (l *Logger) Error(args ...any) { l.dispatch(LoggerTypeError, int(LoggerError), args) }

// Warn 输出警告级日志。
func (l *Logger) Warn(args ...any) { l.dispatch(LoggerTypeWarn, int(LoggerWarn), args) }

// Info 输出信息级日志。
func (l *Logger) Info(args ...any) { l.dispatch(LoggerTypeInfo, int(LoggerInfo), args) }

// Debug 输出调试级日志。
func (l *Logger) Debug(args ...any) { l.dispatch(LoggerTypeDebug, int(LoggerDebug), args) }

// dispatch 对应 TS _method（logger.ts:127-147）：按导出器级别过滤后派发。
// targetLevel = levels[消息名] ?? levels["default"] ?? logger.level ?? INFO。
func (l *Logger) dispatch(typ LoggerType, level int, args []any) {
	if len(args) == 1 {
		if err, ok := args[0].(error); ok {
			if cause := unwrapCause(err); cause != nil {
				l.dispatch(typ, level, []any{cause})
			} else if agg, ok := err.(interface{ Unwrap() []error }); ok {
				for _, item := range agg.Unwrap() {
					l.dispatch(typ, level, []any{item})
				}
				return
			}
		}
	}
	message := &Message{SN: l.service.nextMessageSN(), TS: l.service.ctx.Clock().Now().UnixMilli(), Name: l.name, Type: typ, Level: level, Args: args, Fiber: l.fiber}
	for _, id := range l.service.exporterIDs() {
		exporter := l.service.exporterByID(id)
		if exporter == nil {
			continue
		}
		if err := l.export(exporter, message); err != nil {
			l.service.recordExporterFailure(err)
		}
	}
}

// export 隔离每个导出器的消息和 panic，单个导出器不能破坏后续派发。
func (l *Logger) export(exporter Exporter, message *Message) (err error) {
	defer func() {
		if v := recover(); v != nil {
			err = fmt.Errorf("日志导出器发生 panic: %v", v)
		}
	}()
	if l.resolveLevel(exporterOptions(exporter)) < message.Level {
		return nil
	}
	exporter.Export(cloneMessage(message))
	return nil
}

// recordExporterFailure 直接写入内部缓冲，避免错误导出器触发递归日志。
func (s *LoggerService) recordExporterFailure(err error) {
	m := &Message{SN: s.nextMessageSN(), TS: s.ctx.Clock().Now().UnixMilli(), Name: "logger", Type: LoggerTypeError, Level: int(LoggerError), Args: []any{err}, Fiber: s.ctx.Fiber()}
	s.appendMessage(m)
}

// resolveLevel 解析导出器对该消息名的目标级别。
func (l *Logger) resolveLevel(cfg *ExporterConfig) int {
	if cfg != nil && cfg.Levels != nil {
		if v, ok := cfg.Levels[l.name]; ok {
			return v
		}
		if v, ok := cfg.Levels["default"]; ok {
			return v
		}
	}
	if l.hasLevel {
		return l.level
	}
	return int(LoggerInfo)
}

// LoggerService 的缓冲、导出器集合和序号受锁保护；消息和配置只提供独立快照。
type LoggerService struct {
	ctx        *Context
	mu         *sync.Mutex
	bufferSize int
	buffer     []*Message
	snMessage  uint64
	snExporter int64
	exporters  map[int64]Exporter
	order      []int64 // 保持 TS Map 的插入序（派发按序）
}

// newLoggerService 构造日志服务并登记内建缓冲导出器（logger.ts:189-201，
// colors:3、环形缓冲按 BufferSize 批量裁剪）。其 effect 登记随后被
// NewContext 的 rootFiber.disposables.Clear() 丢弃（清理器不执行、导出器
// 永留，对应 context.ts:47）。
func newLoggerService(ctx *Context) *LoggerService {
	s := &LoggerService{
		ctx:        ctx,
		mu:         ctx.mu,
		bufferSize: 1000,
		exporters:  make(map[int64]Exporter),
	}
	builtin := &bufferExporter{svc: s}
	builtin.SetOptions(ExporterConfig{Colors: 3})
	_, _ = s.Exporter(ctx, builtin)
	return s
}

// InvokeC 对应 TS [symbols.invoke](name?)（logger.ts:226-237）：
// 名字解析链——显式 name > intercept 配置 name > hyphenate(caller.DefSite()
// .Fiber().Name())；level 取 intercept 配置 level。intercept 沿 caller 链
// （use site 链）收集并按「近端覆盖远端」合并（TS 原型链自内向外收集后
// unshift 再 Object.assign 的等价物）。
func (s *LoggerService) InvokeC(caller *Context, args []any) (any, error) {
	var (
		cfgName     string
		hasCfgName  bool
		cfgLevel    int
		hasCfgLevel bool
	)
	configs := caller.InterceptAll("logger")
	for i := len(configs) - 1; i >= 0; i-- {
		m, ok := configs[i].(map[string]any)
		if !ok {
			continue
		}
		if v, ok := m["name"].(string); ok {
			cfgName = v
			hasCfgName = true
		}
		if v := toIntLike(m["level"]); v != nil {
			cfgLevel = *v
			hasCfgLevel = true
		}
	}
	var name string
	if len(args) > 0 {
		if n, ok := args[0].(string); ok {
			name = n
		}
	}
	fiber := caller.DefSite().Fiber()
	if name == "" && hasCfgName {
		name = cfgName
	}
	if name == "" {
		name = hyphenate(fiber.Name())
	}
	return &Logger{
		name:     name,
		level:    cfgLevel,
		hasLevel: hasCfgLevel,
		fiber:    fiber,
		service:  s,
	}, nil
}

// Error/Warn/Info/Debug 对应 TS 根上四方法（logger.ts:239-245）：
// 以构造 ctx（root）解析 logger 后输出（名得 "root"）。
func (s *LoggerService) Error(args ...any) { s.rootMethod(LoggerTypeError, int(LoggerError), args) }

// Warn 根上警告级输出。
func (s *LoggerService) Warn(args ...any) { s.rootMethod(LoggerTypeWarn, int(LoggerWarn), args) }

// Info 根上信息级输出。
func (s *LoggerService) Info(args ...any) { s.rootMethod(LoggerTypeInfo, int(LoggerInfo), args) }

// Debug 根上调试级输出。
func (s *LoggerService) Debug(args ...any) { s.rootMethod(LoggerTypeDebug, int(LoggerDebug), args) }

func (s *LoggerService) rootMethod(typ LoggerType, level int, args []any) {
	v, err := s.InvokeC(s.ctx, nil)
	if err != nil {
		return
	}
	l, _ := v.(*Logger)
	if l == nil {
		return
	}
	l.dispatch(typ, level, args)
}

// Exporter 将导出器登记到调用方的作用域，返回并发安全的幂等退订函数。
func (s *LoggerService) Exporter(access *Context, e Exporter) (func() bool, error) {
	if e == nil || reflect.ValueOf(e).Kind() == reflect.Pointer && reflect.ValueOf(e).IsNil() {
		return nil, fmt.Errorf("日志导出器不能为空")
	}
	wrapper, err := access.Effect("ctx.logger.exporter()", func() (Disposable, error) {
		s.mu.Lock()
		s.snExporter++
		id := s.snExporter
		s.exporters[id] = e
		s.order = append(s.order, id)
		s.mu.Unlock()
		return func(context.Context) error {
			s.mu.Lock()
			delete(s.exporters, id)
			for i, v := range s.order {
				if v == id {
					s.order = append(s.order[:i], s.order[i+1:]...)
					break
				}
			}
			s.mu.Unlock()
			return nil
		}, nil
	})
	if err != nil {
		return nil, err
	}
	var removed atomic.Bool
	return func() bool {
		if !removed.CompareAndSwap(false, true) {
			return false
		}
		return wrapper(context.Background()) == nil
	}, nil
}

// nextMessageSN 分配消息序号（TS 的 ++_snMessage）。
func (s *LoggerService) nextMessageSN() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snMessage++
	return s.snMessage
}

// exporterIDs 返回导出器 id 的插入序快照。
func (s *LoggerService) exporterIDs() []int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]int64(nil), s.order...)
}

// exporterByID 按 id 取导出器。
func (s *LoggerService) exporterByID(id int64) Exporter {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.exporters[id]
}

// bufferExporter 是内建环形缓冲导出器（logger.ts:189-201）：超出
// BufferSize 时批量裁剪（overflow 恰为 1 时单条出队）。
type bufferExporter struct {
	ExporterBase
	svc *LoggerService
}

// Export 实现 Exporter：追加消息并裁剪缓冲。
func (e *bufferExporter) Export(m *Message) { e.svc.appendMessage(m) }

func (s *LoggerService) appendMessage(m *Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// 并发日志可能先分配序号、后到达缓冲；仍按序号保存最近记录。
	index := sort.Search(len(s.buffer), func(i int) bool { return s.buffer[i].SN > m.SN })
	s.buffer = append(s.buffer, nil)
	copy(s.buffer[index+1:], s.buffer[index:])
	s.buffer[index] = m
	if overflow := len(s.buffer) - s.bufferSize; overflow > 0 {
		for i := 0; i < overflow; i++ {
			s.buffer[i] = nil
		}
		s.buffer = s.buffer[overflow:]
	}
}

// hyphenate 对应 cosmokit 的 hyphenate：大写字母前插连字符并转小写。
func hyphenate(source string) string {
	var b strings.Builder
	b.Grow(len(source) + 4)
	for _, ch := range source {
		if ch >= 'A' && ch <= 'Z' {
			b.WriteByte('-')
			b.WriteRune(ch - 'A' + 'a')
		} else {
			b.WriteRune(ch)
		}
	}
	return b.String()
}

// unwrapCause 返回 error 的直接 cause（TS 的 error.cause；Go 以
// errors.Unwrap 承载链式包装；*AggregateError 不实现 Unwrap，走聚合分支）。
func unwrapCause(err error) error {
	if _, ok := err.(*AggregateError); ok {
		return nil
	}
	return errors.Unwrap(err)
}

// exporterOptions 安全读取导出器配置（nil 导出器/配置返回 nil）。
func exporterOptions(exporter Exporter) *ExporterConfig {
	if exporter == nil {
		return nil
	}
	return cloneExporterConfig(exporter.Options())
}

// lookupFormatter 对应 TS 的 `exporter.formatters?.[char] ??
// defaultFormatters[char]`：先查导出器配置、后查默认表。
func lookupFormatter(cfg *ExporterConfig, char byte) Formatter {
	key := string(char)
	if cfg != nil && cfg.Formatters != nil {
		if f, ok := cfg.Formatters[key]; ok && f != nil {
			return f
		}
	}
	return defaultFormatters[key]
}

// formatIntLike 对应 %d/%i：Math.trunc(Number(value))。
func formatIntLike(value any, _ Exporter, _ *Message) any {
	return formatFloat(math.Trunc(toNumber(value)))
}

// formatJSONObject 对应 %o/%O：JSON.stringify 的 Go 等价（json.Marshal），
// 不可序列化（error、chan 等）时回落 fmt.Sprint。
func formatJSONObject(value any, _ Exporter, _ *Message) any {
	if data, err := json.Marshal(value); err == nil {
		return string(data)
	}
	return fmt.Sprint(value)
}

// toNumber 对应 JS Number(value) 的常用子集：数值/布尔/数字字符串按
// JS 规则转换，其余（含 nil 以外的复合值）为 NaN。
func toNumber(value any) float64 {
	switch v := value.(type) {
	case int:
		return float64(v)
	case int8:
		return float64(v)
	case int16:
		return float64(v)
	case int32:
		return float64(v)
	case int64:
		return float64(v)
	case uint:
		return float64(v)
	case uint8:
		return float64(v)
	case uint16:
		return float64(v)
	case uint32:
		return float64(v)
	case uint64:
		return float64(v)
	case float32:
		return float64(v)
	case float64:
		return v
	case bool:
		if v {
			return 1
		}
		return 0
	case string:
		if strings.TrimSpace(v) == "" {
			return 0
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return math.NaN()
		}
		return f
	case nil:
		return 0
	}
	return math.NaN()
}

// formatFloat 把数值转为 JS 风格字符串（NaN/Inf 保字面，整数值不带 .0）。
func formatFloat(f float64) any {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	return f
}

// toIntLike 把 any 转为 int（数值或数字字符串），失败返回 nil。
func toIntLike(value any) *int {
	f := toNumber(value)
	if math.IsNaN(f) {
		return nil
	}
	v := int(f)
	return &v
}

// isASCIILetter 报告字节是否为 ASCII 字母（TS 正则的 [a-zA-Z]）。
func isASCIILetter(ch byte) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
}

// isObjectLike 近似 TS 的 `typeof arg === 'object' && arg`：非 nil 且非
// 标量（bool/字符串/数值）视为对象（map、切片、结构体、error 等）。
// Go 函数值无 typeof 区分，一并视为对象（无行为断言依赖该差异）。
func isObjectLike(v any) bool {
	switch v.(type) {
	case nil, bool, string, []byte,
		int, int8, int16, int32, int64,
		uint, uint8, uint16, uint32, uint64,
		float32, float64:
		return false
	}
	return true
}

// truncateLine 对应 TS 的 line.slice(0, maxLength) 加超长时的省略号后缀
// （按字符截断，等价 JS 的 UTF-16 码元语义于 BMP 内一致）。
func truncateLine(line string, maxLength int) string {
	runes := []rune(line)
	if maxLength < 0 {
		maxLength = max(0, len(runes)+maxLength)
	}
	if len(runes) <= maxLength {
		return line
	}
	return string(runes[:maxLength]) + "..."
}

// Messages 返回独立日志快照，调用方不可变更缓冲本体。
func (s *LoggerService) Messages() []*Message {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*Message, len(s.buffer))
	for i, m := range s.buffer {
		out[i] = cloneMessage(m)
	}
	return out
}

// SetBufferSize 调整内存日志上限。
func (s *LoggerService) SetBufferSize(size int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if size < 0 {
		size = 0
	}
	s.bufferSize = size
	if len(s.buffer) > size {
		overflow := len(s.buffer) - size
		for i := 0; i < overflow; i++ {
			s.buffer[i] = nil
		}
		s.buffer = s.buffer[overflow:]
	}
}

// cloneMessage 复制日志容器数据；服务对象、error 等指针值由调用方保持不可变。
// 记录已访问的容器身份以支持循环 map/slice，不能用 JSON 往返破坏原始类型。
func cloneMessage(message *Message) *Message {
	clone := *message
	clone.Args = cloneLogValue(reflect.ValueOf(message.Args), make(map[logVisit]reflect.Value)).Interface().([]any)
	if message.Meta != nil {
		clone.Meta = cloneLogValue(reflect.ValueOf(message.Meta), make(map[logVisit]reflect.Value)).Interface().(map[string]any)
	}
	return &clone
}

type logVisit struct {
	kind    reflect.Kind
	typ     reflect.Type
	pointer uintptr
	length  int
}

func cloneLogValue(value reflect.Value, seen map[logVisit]reflect.Value) reflect.Value {
	switch value.Kind() {
	case reflect.Interface:
		if value.IsNil() {
			return reflect.Zero(value.Type())
		}
		clone := reflect.New(value.Type()).Elem()
		clone.Set(cloneLogValue(value.Elem(), seen))
		return clone
	case reflect.Map:
		if value.IsNil() {
			return reflect.Zero(value.Type())
		}
		key := logVisit{kind: value.Kind(), typ: value.Type(), pointer: value.Pointer()}
		if clone, ok := seen[key]; ok {
			return clone
		}
		clone := reflect.MakeMapWithSize(value.Type(), value.Len())
		seen[key] = clone
		iter := value.MapRange()
		for iter.Next() {
			clone.SetMapIndex(iter.Key(), cloneLogValue(iter.Value(), seen))
		}
		return clone
	case reflect.Slice:
		if value.IsNil() {
			return reflect.Zero(value.Type())
		}
		key := logVisit{kind: value.Kind(), typ: value.Type(), pointer: value.Pointer(), length: value.Len()}
		if clone, ok := seen[key]; ok {
			return clone
		}
		clone := reflect.MakeSlice(value.Type(), value.Len(), value.Len())
		seen[key] = clone
		for i := 0; i < value.Len(); i++ {
			clone.Index(i).Set(cloneLogValue(value.Index(i), seen))
		}
		return clone
	case reflect.Struct:
		clone := reflect.New(value.Type()).Elem()
		clone.Set(value)
		for i := 0; i < value.NumField(); i++ {
			if value.Type().Field(i).IsExported() {
				clone.Field(i).Set(cloneLogValue(value.Field(i), seen))
			}
		}
		return clone
	case reflect.Array:
		clone := reflect.New(value.Type()).Elem()
		for i := 0; i < value.Len(); i++ {
			clone.Index(i).Set(cloneLogValue(value.Index(i), seen))
		}
		return clone
	default:
		return value
	}
}
