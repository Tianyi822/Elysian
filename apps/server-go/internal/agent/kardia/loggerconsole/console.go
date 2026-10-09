// console.go 对应 TS logger-console 包的服务端路径（src/shared.ts 的
// ConsoleExporter）。node 入口（src/index.ts）的 supports-color 探测与
// node:util.inspect 专用 o/O formatter 不移植（方案 2.9 与差异清单第 9 条），
// %o/%O 沿用 kardia 默认 formatter；浏览器入口（src/browser.ts，console
// 方法分派）在 Go 无对应物，不移植。渲染布局照搬 shared.ts:69-93；
// cosmokit 的 Time.template 与 Time.format（diff 人读格式）按语义自实现并单测。
package loggerconsole

import (
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"elysian/server/internal/agent/kardia"
)

// LabelStyle 对应 TS LabelStyle（shared.ts:7-11）。
type LabelStyle struct {
	// Width 是标签列的目标宽度（TS label.width）。
	Width *int

	// Margin 是标签两侧的空格数（TS label.margin）。
	Margin *int

	// Align 取 "left" 或 "right"。
	Align string
}

// Config 对应 TS ConsoleExporter.Config（shared.ts:13-22）。指针字段区分
// 「未指定」（取默认）与「显式值」；声明式 schema 校验不移植（差异清单
// 第 7 条），默认值在 New 内手写：Colors 0（无色）、ShowDiff false、
// ShowTime "yyyy-MM-dd hh:mm:ss "（空串关闭时间前缀）、MaxLength nil
// （由 kardia.LoggerFormat 按默认 10240 处理）。
type Config struct {
	Colors    int
	MaxLength *int
	Levels    map[string]int
	// Output 是输出目标，缺省为 os.Stdout；同一个导出器的写入串行执行。
	Output   io.Writer
	ShowDiff *bool
	ShowTime *string
	Label    *LabelStyle
}

// ConsoleExporter 在构造时复制配置，独立锁保护时间戳、渲染和写入。
type ConsoleExporter struct {
	kardia.ExporterBase
	// timestamp 是上一条渲染消息的 ts（showDiff 用）；TS 构造时取
	// Date.now()，Go 一律走注入时钟。
	timestamp int64

	label    *LabelStyle
	showTime string
	showDiff bool
	out      io.Writer
	mu       sync.Mutex
	writeMu  sync.Mutex
}

// New 构造导出器并经 ctx.LoggerService().Exporter 登记（shared.ts:50-54，
// Object.assign(this, this.getDefaults(), config) 的等价物：Config 的零值
// 与 nil 指针回落默认）。TS 基类的 formatters = {} 在 Go 为非 nil 空表，
// 供宿主与测试按名追加自定义 formatter。
func New(ctx *kardia.Context, cfg Config) (*ConsoleExporter, error) {
	e := &ConsoleExporter{out: cfg.Output}
	if e.out == nil {
		e.out = os.Stdout
	}
	e.SetOptions(kardia.ExporterConfig{Colors: cfg.Colors, MaxLength: cfg.MaxLength, Levels: cfg.Levels, Formatters: map[string]kardia.Formatter{}})
	e.showDiff = cfg.ShowDiff != nil && *cfg.ShowDiff
	e.showTime = "yyyy-MM-dd hh:mm:ss "
	if cfg.ShowTime != nil {
		e.showTime = *cfg.ShowTime
	}
	if cfg.Label != nil {
		label := *cfg.Label
		if label.Width != nil {
			value := *label.Width
			label.Width = &value
		}
		if label.Margin != nil {
			value := *label.Margin
			label.Margin = &value
		}
		e.label = &label
	}
	e.timestamp = ctx.Clock().Now().UnixMilli()
	if _, err := ctx.LoggerService().Exporter(ctx, e); err != nil {
		return nil, err
	}
	return e, nil
}

// Export 对应 shared.ts:64-67 的 console.log：渲染一行并写出（默认
// os.Stdout；fmt.Fprintln 的一次 Write 补上 console.log 的换行）。
func (e *ConsoleExporter) Export(m *kardia.Message) {
	line := e.Render(m)
	e.writeMu.Lock()
	defer e.writeMu.Unlock()
	out := e.out
	if out == nil {
		out = os.Stdout
	}
	fmt.Fprintln(out, line)
}

// Render 布局照搬 shared.ts:69-93：`[T]` 前缀 + 时间前缀（可关）+
// 着色标签（左右对齐可选）+ 格式化正文（换行按 indent 续行缩进）+
// diff 后缀（showDiff 且上一条 ts 非零）。最后更新时间戳。
func (e *ConsoleExporter) Render(m *kardia.Message) string {
	e.mu.Lock()
	previous := e.timestamp
	e.timestamp = m.TS
	e.mu.Unlock()
	return e.render(m, previous)
}

func (e *ConsoleExporter) render(m *kardia.Message, previous int64) string {
	prefix := "["
	if len(m.Type) > 0 {
		prefix += strings.ToUpper(string(m.Type[:1]))
	}
	prefix += "]"
	space := " "
	width := 0
	alignRight := false
	if e.label != nil {
		if e.label.Margin != nil {
			space = strings.Repeat(" ", *e.label.Margin)
		}
		if e.label.Width != nil {
			width = *e.label.Width
		}
		alignRight = e.label.Align == "right"
	}
	indent := 3 + len(space)
	var output strings.Builder
	if e.showTime != "" {
		// TS 以渲染时刻的 new Date() 取值；Go 取消息 ts——假时钟下消息
		// 派发与导出在同一虚拟时刻，两者等价（见自报偏差）。indent 按
		// 模板长度计（TS 的 this.showTime.length）。
		indent += len(e.showTime)
		output.WriteString(kardia.LoggerColor(e, 8, timeTemplate(e.showTime, time.UnixMilli(m.TS)), ""))
	}
	colors := e.Options().Colors
	code := kardia.LoggerCode(m.Name, colors)
	label := kardia.LoggerColor(e, code, m.Name, ";1")
	// padLength 补偿着色串里的 ANSI 控制字符，使可视宽度等于 label.width
	//（TS 同式；长度按字符计，协议内日志名均为 ASCII）。
	padLength := width + utf8.RuneCountInString(label) - utf8.RuneCountInString(m.Name)
	if alignRight {
		output.WriteString(padStart(label, padLength) + space + prefix + space)
		indent += width + len(space)
	} else {
		output.WriteString(prefix + space + padEnd(label, padLength) + space)
	}
	body := kardia.LoggerFormat(e, m)
	output.WriteString(strings.ReplaceAll(body, "\n", "\n"+strings.Repeat(" ", indent)))
	if e.showDiff && previous != 0 {
		diff := m.TS - previous
		output.WriteString(kardia.LoggerColor(e, code, " +"+formatDiff(diff), ""))
	}
	return output.String()
}

// Plugin 对应 TS 的静态插件形态（static readonly name = 'logger-console'，
// 类构造器即插件回调）：装载即构造并登记导出器；清理由 New 登记的
// ctx.logger.exporter() effect 随 fiber 销毁自动撤销。
var Plugin = &kardia.Plugin{
	Name:  "logger-console",
	Apply: newExporter,
}

// newExporter 对应插件系统调用 new ConsoleExporter(ctx, config)。
func newExporter(ctx *kardia.Context, config any) (kardia.Disposable, error) {
	cfg, err := parseConfig(config)
	if err != nil {
		return nil, err
	}
	_, err = New(ctx, cfg)
	return nil, err
}

// parseConfig 把插件配置解析为 Config：nil 为空配置，接受 Config 直传与
// map 形态（YAML/JSON 装载路径）；未知键忽略（schema 校验不移植，差异
// 清单第 7 条）。
func parseConfig(config any) (Config, error) {
	switch c := config.(type) {
	case nil:
		return Config{}, nil
	case Config:
		return c, nil
	case *Config:
		if c == nil {
			return Config{}, nil
		}
		return *c, nil
	case map[string]any:
		return configFromMap(c)
	}
	return Config{}, fmt.Errorf("logger-console：无法识别的配置类型 %T，期望对象", config)
}

// configFromMap 从 map 形态配置构造 Config，键名与 TS Config 一致。
func configFromMap(m map[string]any) (Config, error) {
	var cfg Config
	if v, ok := m["colors"]; ok {
		n, err := numberOf("colors", v)
		if err != nil {
			return cfg, err
		}
		cfg.Colors = n
	}
	if v, ok := m["maxLength"]; ok {
		n, err := numberOf("maxLength", v)
		if err != nil {
			return cfg, err
		}
		cfg.MaxLength = &n
	}
	if v, ok := m["levels"]; ok {
		lm, ok := v.(map[string]any)
		if !ok {
			return cfg, fmt.Errorf("logger-console：配置项 %q 应为对象，实际 %T", "levels", v)
		}
		levels := make(map[string]int, len(lm))
		for name, lv := range lm {
			n, err := numberOf("levels."+name, lv)
			if err != nil {
				return cfg, err
			}
			levels[name] = n
		}
		cfg.Levels = levels
	}
	if v, ok := m["showDiff"]; ok {
		b, ok := v.(bool)
		if !ok {
			return cfg, fmt.Errorf("logger-console：配置项 %q 应为布尔值，实际 %T", "showDiff", v)
		}
		cfg.ShowDiff = &b
	}
	if v, ok := m["showTime"]; ok {
		s, ok := v.(string)
		if !ok {
			return cfg, fmt.Errorf("logger-console：配置项 %q 应为字符串，实际 %T", "showTime", v)
		}
		cfg.ShowTime = &s
	}
	if v, ok := m["label"]; ok {
		lm, ok := v.(map[string]any)
		if !ok {
			return cfg, fmt.Errorf("logger-console：配置项 %q 应为对象，实际 %T", "label", v)
		}
		label := &LabelStyle{}
		if w, ok := lm["width"]; ok {
			n, err := numberOf("label.width", w)
			if err != nil {
				return cfg, err
			}
			label.Width = &n
		}
		if mg, ok := lm["margin"]; ok {
			n, err := numberOf("label.margin", mg)
			if err != nil {
				return cfg, err
			}
			label.Margin = &n
		}
		if a, ok := lm["align"]; ok {
			s, ok := a.(string)
			if !ok {
				return cfg, fmt.Errorf("logger-console：配置项 %q 应为字符串，实际 %T", "label.align", a)
			}
			label.Align = s
		}
		cfg.Label = label
	}
	return cfg, nil
}

// numberOf 把配置值收敛为 int（数值的各常见承载类型）。
func numberOf(key string, v any) (int, error) {
	switch n := v.(type) {
	case int:
		return n, nil
	case int8:
		return int(n), nil
	case int16:
		return int(n), nil
	case int32:
		return int(n), nil
	case int64:
		return int(n), nil
	case uint:
		return int(n), nil
	case uint8:
		return int(n), nil
	case uint16:
		return int(n), nil
	case uint32:
		return int(n), nil
	case uint64:
		return int(n), nil
	case float32:
		return int(n), nil
	case float64:
		return int(n), nil
	}
	return 0, fmt.Errorf("logger-console：配置项 %q 应为数值，实际 %T", key, v)
}

// padStart 对应 JS String.prototype.padStart：按字符数补空格到目标长度，
// 目标长度小于现长时不改动。
func padStart(s string, n int) string {
	d := n - utf8.RuneCountInString(s)
	if d <= 0 {
		return s
	}
	return strings.Repeat(" ", d) + s
}

// padEnd 对应 JS String.prototype.padEnd。
func padEnd(s string, n int) string {
	d := n - utf8.RuneCountInString(s)
	if d <= 0 {
		return s
	}
	return s + strings.Repeat(" ", d)
}

// diffSecond/diffMinute/diffHour/diffDay 是 Time.format 的毫秒单位常量
// （cosmokit time.ts:2-7）。
const (
	diffSecond int64 = 1000
	diffMinute int64 = 60 * diffSecond
	diffHour   int64 = 60 * diffMinute
	diffDay    int64 = 24 * diffHour
)

// formatDiff 对应 cosmokit Time.format（time.ts:62-74）：毫秒时差的人读
// 格式，单位阈值取「下一单位减半个小单位」（如 59499ms 仍是 59s，
// 59500ms 进位为 1m）。
func formatDiff(ms int64) string {
	abs := ms
	if abs < 0 {
		abs = -abs
	}
	switch {
	case abs >= diffDay-diffHour/2:
		return strconv.FormatInt(jsRoundDiv(ms, diffDay), 10) + "d"
	case abs >= diffHour-diffMinute/2:
		return strconv.FormatInt(jsRoundDiv(ms, diffHour), 10) + "h"
	case abs >= diffMinute-diffSecond/2:
		return strconv.FormatInt(jsRoundDiv(ms, diffMinute), 10) + "m"
	case abs >= diffSecond:
		return strconv.FormatInt(jsRoundDiv(ms, diffSecond), 10) + "s"
	}
	return strconv.FormatInt(ms, 10) + "ms"
}

// jsRoundDiv 复刻 JS 的 Math.round(ms / unit)：半数向 +Infinity 取整
// （Go math.Round 半数远离零，负半数结果不同，如 -1.5s：JS 得 -1s）。
func jsRoundDiv(ms, unit int64) int64 {
	return int64(math.Floor(float64(ms)/float64(unit) + 0.5))
}

// timeTemplate 对应 cosmokit Time.template（time.ts:80-90）：按 yyyy/yy/
// MM/dd/hh/mm/ss/SSS 的固定次序替换，每个记号只替换第一次出现；字段取
// t 的墙钟值（调用方决定时区，Render 传 time.UnixMilli 的本地值，对应
// TS 的本地时间 getter）。
func timeTemplate(tmpl string, t time.Time) string {
	out := tmpl
	out = strings.Replace(out, "yyyy", strconv.Itoa(t.Year()), 1)
	out = strings.Replace(out, "yy", yearSuffix(t.Year()), 1)
	out = strings.Replace(out, "MM", toDigits(int(t.Month()), 2), 1)
	out = strings.Replace(out, "dd", toDigits(t.Day(), 2), 1)
	out = strings.Replace(out, "hh", toDigits(t.Hour(), 2), 1)
	out = strings.Replace(out, "mm", toDigits(t.Minute(), 2), 1)
	out = strings.Replace(out, "ss", toDigits(t.Second(), 2), 1)
	out = strings.Replace(out, "SSS", toDigits(t.Nanosecond()/1e6, 3), 1)
	return out
}

// yearSuffix 对应 getFullYear().toString().slice(2)：取年份后两位
// （公元纪年年份恒为四位，短于两位仅防御）。
func yearSuffix(year int) string {
	s := strconv.Itoa(year)
	if len(s) < 2 {
		return s
	}
	return s[len(s)-2:]
}

// toDigits 对应 cosmokit Time.toDigits：不足长度前补零。
func toDigits(source, length int) string {
	return fmt.Sprintf("%0*d", length, source)
}
