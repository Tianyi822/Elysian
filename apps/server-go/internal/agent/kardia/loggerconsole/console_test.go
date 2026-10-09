package loggerconsole

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/kardia/clock"
)

// 对应 logger-console/tests/index.spec.ts 的 5 个用例（渲染断言按 Go
// 格式化等价物，时钟经 Manual）与方案 2.9 要求的自建单测（Time.template、
// Time.format、配置解析）。TS spec 的 fake now 为真实 Date.now()（毫秒
// 非零），故基准时刻取毫秒非零的固定时间：Timestamp 为 0 会被 TS 的
// 真值判定视为「无上一条」而关闭 diff。
var consoleBaseTime = time.Date(2026, 10, 8, 12, 34, 56, 789000000, time.UTC)

// newTestExporter 复刻 spec 的 beforeAll：假时钟 ctx、colors 0、showDiff
// 开、showTime 关（TS 里 export 被替换为捕获 render 输出，Go 以同包的
// out 接缝承载）。
func newTestExporter(t *testing.T) (*kardia.Context, *clock.Manual, *ConsoleExporter, *strings.Builder) {
	clk := clock.NewManual(consoleBaseTime)
	ctx := kardia.NewContext(kardia.WithClock(clk))
	e, err := New(ctx, Config{ShowDiff: boolPtr(true), ShowTime: strPtr("")})
	if err != nil {
		t.Fatal(err)
	}
	buf := &strings.Builder{}
	e.out = buf
	return ctx, clk, e, buf
}

func boolPtr(b bool) *bool { return &b }

func strPtr(s string) *string { return &s }

func intPtr(i int) *int { return &i }

// TestConsoleFormatError 对应 'format error'：聚合错误逐条展开且聚合本体
// 不输出，子错误取文案（TS 的 inner.stack = undefined 使 Logger.format
// 回落 error.message；Go 无 stack 字段，Error() 即文案），首条 diff 为
// +0ms（构造时的 Timestamp 与首条消息同虚拟时刻）。
func TestConsoleFormatError(t *testing.T) {
	ctx, _, _, buf := newTestExporter(t)
	outer := &kardia.AggregateError{Errors: []error{errors.New("message")}}
	ctx.Logger("test").Error(outer)
	want := "[E] test message +0ms\n"
	if got := buf.String(); got != want {
		t.Fatalf("输出不符：got %q want %q", got, want)
	}
}

// TestConsoleFormatObject 对应 'format object'：非字符串首参前置 %o，
// Go 默认 %o 为 JSON 化（TS 的 { foo: 'bar' } 属 node:util.inspect 风格，
// 不移植，见方案差异清单第 9 条），diff +2ms。
func TestConsoleFormatObject(t *testing.T) {
	ctx, clk, _, buf := newTestExporter(t)
	clk.Advance(2 * time.Millisecond)
	ctx.Logger("test").Info(map[string]any{"foo": "bar"})
	want := "[I] test {\"foo\":\"bar\"} +2ms\n"
	if got := buf.String(); got != want {
		t.Fatalf("输出不符：got %q want %q", got, want)
	}
}

// TestConsoleCustomFormatter 对应 'custom formatter'：按名追加的 formatter
// 参与 %x 替换且无实参可用，%% 收敛为字面 %（'%x%%x' → 'custom%x'），
// diff +1ms。
func TestConsoleCustomFormatter(t *testing.T) {
	ctx, clk, e, buf := newTestExporter(t)
	clk.Advance(1 * time.Millisecond)
	options := e.Options()
	options.Formatters["x"] = func(_ any, _ kardia.Exporter, _ *kardia.Message) any {
		return "custom"
	}
	e.SetOptions(*options)
	ctx.Logger("test").Info("%x%%x")
	want := "[I] test custom%x +1ms\n"
	if got := buf.String(); got != want {
		t.Fatalf("输出不符：got %q want %q", got, want)
	}
}

// TestConsoleLogLevels 对应 'log levels'：默认目标级别 INFO 下 debug 不
// 输出；级别提为 3 后输出。TS 的 logger.level = 3 是公有字段赋值，Go 的
// hasLevel 未导出，经 intercept('logger', { level: 3 }) 的等价通道获得
// 同名同级别的 logger。
func TestConsoleLogLevels(t *testing.T) {
	ctx, _, _, buf := newTestExporter(t)
	logger := ctx.Logger("test")
	logger.Debug("%C", "foo bar")
	if got := buf.String(); got != "" {
		t.Fatalf("默认级别下不应输出 debug 日志，实际 %q", got)
	}
	leveled := ctx.Intercept("logger", map[string]any{"level": 3}).Logger("test")
	leveled.Debug("%C", "foo bar")
	if got := buf.String(); !strings.Contains(got, "[D] test foo bar") {
		t.Fatalf("级别 3 下应输出 debug 日志，实际 %q", got)
	}
}

// TestConsoleLabelStyle 对应 'label style'：右对齐标签（width 10、
// margin 2）重排前缀并使续行缩进 = 3 + 2 + 20（width+space）。TS spec
// 在用例内改写 exporter.label，Go 以同包直写复刻。
func TestConsoleLabelStyle(t *testing.T) {
	ctx, _, e, buf := newTestExporter(t)
	e.label = &LabelStyle{Align: "right", Width: intPtr(10), Margin: intPtr(2)}
	ctx.Logger("test").Info("message\nmessage")
	want := "      test  [I]  message\n" + strings.Repeat(" ", 17) + "message +0ms\n"
	if got := buf.String(); got != want {
		t.Fatalf("输出不符：got %q want %q", got, want)
	}
}

// TestConsoleShowTime 自建：默认 showTime（"yyyy-MM-dd hh:mm:ss "）渲染
// 时间前缀且续行缩进计入模板长度 20 + 3 + 1 = 24；showDiff 默认关闭无
// diff 后缀。期望值以 Go 本地时间格式化（与 time.UnixMilli 同一时区
// 口径）为独立基准，不依赖机器时区。
func TestConsoleShowTime(t *testing.T) {
	clk := clock.NewManual(consoleBaseTime)
	ctx := kardia.NewContext(kardia.WithClock(clk))
	e, err := New(ctx, Config{})
	if err != nil {
		t.Fatal(err)
	}
	buf := &strings.Builder{}
	e.out = buf
	ctx.Logger("test").Info("a\nb")
	timeStr := time.UnixMilli(consoleBaseTime.UnixMilli()).Format("2006-01-02 15:04:05") + " "
	want := timeStr + "[I] test a\n" + strings.Repeat(" ", 24) + "b\n"
	if got := buf.String(); got != want {
		t.Fatalf("输出不符：got %q want %q", got, want)
	}
}

// TestTimeTemplate 自建（方案 2.9）：Time.template 的记号次序、补零与
// 「每个记号只替换第一次出现」语义（cosmokit time.ts:80-90 为链式单次
// replace：yyyy 消费第一次出现后，yy 会吃掉剩余 yyyy 的前两位——
// "yyyy/yyyy" 的第二段只剩 "yy" 尾巴，非全文全局替换）。
func TestTimeTemplate(t *testing.T) {
	base := time.Date(2026, 10, 8, 9, 5, 7, 123000000, time.UTC)
	cases := []struct {
		tmpl string
		want string
	}{
		{"yyyy-MM-dd hh:mm:ss ", "2026-10-08 09:05:07 "},
		{"yy/MM/dd SSS", "26/10/08 123"},
		{"hh:mm:ss.SSS", "09:05:07.123"},
		{"yyyy/yyyy", "2026/26yy"},
		{"", ""},
	}
	for _, c := range cases {
		if got := timeTemplate(c.tmpl, base); got != c.want {
			t.Errorf("timeTemplate(%q) = %q, want %q", c.tmpl, got, c.want)
		}
	}
}

// TestFormatDiff 自建（方案 2.9）：Time.format 的人读格式与单位进位阈值
// （下一单位减半个小单位），含 JS Math.round 的负半数语义。
func TestFormatDiff(t *testing.T) {
	cases := []struct {
		ms   int64
		want string
	}{
		{0, "0ms"},
		{1, "1ms"},
		{999, "999ms"},
		{1000, "1s"},
		{1500, "2s"},
		{59000, "59s"},
		{59499, "59s"},
		{59500, "1m"},
		{3569999, "59m"},
		{3570000, "1h"},
		{84599999, "23h"},
		{84600000, "1d"},
		{-5, "-5ms"},
		{-1500, "-1s"},
		{-2000, "-2s"},
	}
	for _, c := range cases {
		if got := formatDiff(c.ms); got != c.want {
			t.Errorf("formatDiff(%d) = %q, want %q", c.ms, got, c.want)
		}
	}
}

// TestConsolePluginApply 自建：插件回调（Plugin.Apply）的配置解析——map
// 形态按 TS 键名取值，nil 配置取空，非法类型返回中文错误。
func TestConsolePluginApply(t *testing.T) {
	clk := clock.NewManual(consoleBaseTime)
	ctx := kardia.NewContext(kardia.WithClock(clk))
	if _, err := newExporter(ctx, nil); err != nil {
		t.Fatalf("nil 配置不应报错：%v", err)
	}
	cfg, err := parseConfig(map[string]any{
		"colors":   0,
		"showDiff": true,
		"showTime": "",
		"label": map[string]any{
			"width":  10,
			"margin": 2,
			"align":  "right",
		},
	})
	if err != nil {
		t.Fatalf("map 配置解析失败：%v", err)
	}
	if cfg.ShowDiff == nil || !*cfg.ShowDiff {
		t.Fatalf("showDiff 应为 true，实际 %v", cfg.ShowDiff)
	}
	if cfg.ShowTime == nil || *cfg.ShowTime != "" {
		t.Fatalf("showTime 应为空串，实际 %v", cfg.ShowTime)
	}
	if cfg.Label == nil || cfg.Label.Width == nil || *cfg.Label.Width != 10 ||
		cfg.Label.Margin == nil || *cfg.Label.Margin != 2 || cfg.Label.Align != "right" {
		t.Fatalf("label 解析不符：%+v", cfg.Label)
	}
	if _, err := parseConfig(42); err == nil {
		t.Fatal("非法配置类型应返回错误")
	}
	if _, err := parseConfig(map[string]any{"levels": "x"}); err == nil {
		t.Fatal("levels 非对象应返回错误")
	}
}

func TestExporterFollowsCallingPluginLifetime(t *testing.T) {
	root := kardia.NewContext()
	buf := &strings.Builder{}
	fiber, err := root.Plugin(&kardia.Plugin{Name: "console-owner", Apply: func(ctx *kardia.Context, _ any) (kardia.Disposable, error) {
		_, err := New(ctx, Config{ShowTime: strPtr(""), Output: buf})
		return nil, err
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fiber.Await(context.Background()); err != nil {
		t.Fatal(err)
	}
	root.Logger("test").Info("活动")
	if !strings.Contains(buf.String(), "活动") {
		t.Fatal("活动导出器未收到消息")
	}
	if err := fiber.Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
	before := buf.String()
	root.Logger("test").Info("停止")
	if got := buf.String(); got != before {
		t.Fatalf("插件卸载后继续导出日志：%q", got)
	}
	if err := root.Fiber().Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentExportsSerializeWriter(t *testing.T) {
	root := kardia.NewContext()
	buf := &strings.Builder{}
	_, err := New(root, Config{ShowTime: strPtr(""), Output: buf})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); root.Logger("test").Info("消息") }()
	}
	wg.Wait()
	if count := strings.Count(buf.String(), "消息\n"); count != 100 {
		t.Fatalf("输出记录 %d，期望 100", count)
	}
	if err := root.Fiber().Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestConsoleFormatterCanLogWithoutHoldingRenderLock(t *testing.T) {
	ctx, _, e, buf := newTestExporter(t)
	options := e.Options()
	options.Formatters["x"] = func(any, kardia.Exporter, *kardia.Message) any {
		ctx.Logger("inner").Info("格式化日志")
		return "正文"
	}
	e.SetOptions(*options)
	done := make(chan struct{})
	go func() { ctx.Logger("outer").Info("%x"); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("formatter 内日志调用被渲染锁阻塞")
	}
	if !strings.Contains(buf.String(), "格式化日志") || !strings.Contains(buf.String(), "正文") {
		t.Fatalf("日志缺失：%s", buf.String())
	}
}
