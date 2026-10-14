package kardia

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// 对应 core/tests/logger.spec.ts（9 个用例，其中名字解析 7）与方案 2.5
// 要求的自建单测（hyphenate、LoggerFormat、LoggerCode）。TS 的
// ctx.logger.info 等根方法对应 root.Logger().Info（等价 root.LoggerService
// ().Info：均以 root 解析名字）。

// loggerCaptureExporter 收集导出消息的测试导出器。
type loggerCaptureExporter struct {
	ExporterBase
	captured *[]*Message
}

// Export 实现 Exporter。
func (e *loggerCaptureExporter) Export(m *Message) { *e.captured = append(*e.captured, m) }

// loggerPlainExporter 是零配置导出器（format 单测用）。
type loggerPlainExporter struct {
	ExporterBase
}

// Export 实现 Exporter。
func (e *loggerPlainExporter) Export(*Message) {}

// loggerSetup 对应 spec 的 setup：levels.default=3 的捕获导出器。
func loggerSetup() (*Context, *[]*Message) {
	root := NewContext()
	captured := &[]*Message{}
	exporter := &loggerCaptureExporter{captured: captured}
	exporter.SetOptions(ExporterConfig{Levels: map[string]int{"default": 3}})
	root.LoggerService().Exporter(root, exporter)
	return root, captured
}

// loggerNames 提取捕获消息的名字序列。
func loggerNames(captured *[]*Message) []string {
	names := make([]string, 0, len(*captured))
	for _, m := range *captured {
		names = append(names, m.Name)
	}
	return names
}

// loggerDriverFoo 对应名字解析用例的 FooService（static name 'foo:driver'）：
// Action 内经 this.ctx 输出日志。
type loggerDriverFoo struct {
	Service
}

// Action 对应 action()：this.ctx.logger.debug（Go：CtxFor(access).Logger()）。
func (s *loggerDriverFoo) Action(access *Context) {
	s.CtxFor(access).Logger().Debug("from action")
}

// loggerDriverBar 对应 'uses the innermost service name' 的 BarService。
type loggerDriverBar struct {
	Service
}

// Action 对应 action()：this.ctx.logger.debug。
func (s *loggerDriverBar) Action(access *Context) {
	s.CtxFor(access).Logger().Debug("from bar")
}

// loggerDriverFooBar 对应 'uses the innermost service name' 的 FooService
// （inject ['bar']，Action 先经 this.ctx.bar.action() 再输出自身日志）。
type loggerDriverFooBar struct {
	Service
}

// Action 对应 action()：内嵌服务调用与外层恢复的名字归属断言依据。
func (s *loggerDriverFooBar) Action(access *Context) error {
	v, err := s.CtxFor(access).Get("bar")
	if err != nil {
		return err
	}
	bar, _ := v.(*loggerDriverBar)
	if bar == nil {
		return errors.New("bar 服务类型不符")
	}
	bar.Action(s.CtxFor(access))
	s.CtxFor(access).Logger().Debug("from foo")
	return nil
}

// loggerFooPlugin 构造 provide "foo" 的插件（name 即 fiber 名）。
func loggerFooPlugin(name string) *Plugin {
	return &Plugin{
		Name: name,
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &loggerDriverFoo{}
			s.Service = newTestService(c, "foo", s, nil)
			return nil, nil
		},
	}
}

// TestLoggerBoundedBuffer 对应 'keeps the bounded buffer in place and
// chronological'：环形缓冲按 BufferSize 批量裁剪、保持时序。TS 的
// toBe(buffer) 引用断言在 Go 切片语义下无逐字等价，以内容断言承载。
func TestLoggerBoundedBuffer(t *testing.T) {
	root := NewContext()
	s := root.LoggerService()
	s.SetBufferSize(2)
	bufferArgs := func() []string {
		args := make([]string, 0, len(s.Messages()))
		for _, m := range s.Messages() {
			args = append(args, m.Args[0].(string))
		}
		return args
	}
	s.Info("one")
	s.Info("two")
	s.Info("three")
	if !reflect.DeepEqual(bufferArgs(), []string{"two", "three"}) {
		t.Fatalf("缓冲应保留最近两条，实际 %v", bufferArgs())
	}

	s.SetBufferSize(1)
	s.Info("four")
	if !reflect.DeepEqual(bufferArgs(), []string{"four"}) {
		t.Fatalf("缓冲容量 1 时应只剩 four，实际 %v", bufferArgs())
	}

	s.SetBufferSize(0)
	s.Info("five")
	if len(s.Messages()) != 0 {
		t.Fatalf("缓冲容量 0 时应为空，实际 %v", bufferArgs())
	}
}

// TestLoggerExporterDisposal 对应 'disposes the exporter that registered
// the disposer'：清空既有导出器后，各自退订只撤销自己的登记。
func TestLoggerExporterDisposal(t *testing.T) {
	root := NewContext()
	s := root.LoggerService()
	// 等价 TS 的 ctx.logger.exporters.clear()（同包直取内部表）
	s.mu.Lock()
	s.exporters = make(map[int64]Exporter)
	s.order = nil
	s.mu.Unlock()

	first := &[]*Message{}
	second := &[]*Message{}
	eFirst := &loggerCaptureExporter{captured: first}
	eSecond := &loggerCaptureExporter{captured: second}
	disposeFirst, _ := s.Exporter(root, eFirst)
	disposeSecond, _ := s.Exporter(root, eSecond)

	disposeFirst()
	s.Info("test")
	if len(*first) != 0 {
		t.Fatalf("已退订的导出器不应再收到消息，实际 %d 条", len(*first))
	}
	if len(*second) != 1 {
		t.Fatalf("未退订的导出器应收到 1 条，实际 %d 条", len(*second))
	}

	disposeSecond()
	s.Info("test")
	if len(*second) != 1 {
		t.Fatalf("全部退订后不应再收到消息，实际 %d 条", len(*second))
	}
}

// TestLoggerFiberNameFromOutside 对应 'uses fiber name when called from
// outside any service'：根上直接调用取 root fiber 名。
func TestLoggerFiberNameFromOutside(t *testing.T) {
	root, captured := loggerSetup()
	root.Logger().Debug("hello")
	if !reflect.DeepEqual(loggerNames(captured), []string{"root"}) {
		t.Fatalf("消息名应为 root，实际 %v", loggerNames(captured))
	}
}

// TestLoggerExplicitName 对应 'honours explicit name argument'。
func TestLoggerExplicitName(t *testing.T) {
	root, captured := loggerSetup()
	root.Logger("custom").Debug("hello")
	if !reflect.DeepEqual(loggerNames(captured), []string{"custom"}) {
		t.Fatalf("消息名应为 custom，实际 %v", loggerNames(captured))
	}
}

// TestLoggerInterceptName 对应 'honours intercept name'。
func TestLoggerInterceptName(t *testing.T) {
	root, captured := loggerSetup()
	intercepted := root.Intercept("logger", map[string]any{"name": "intercepted"})
	intercepted.Logger().Debug("hello")
	if !reflect.DeepEqual(loggerNames(captured), []string{"intercepted"}) {
		t.Fatalf("消息名应为 intercepted，实际 %v", loggerNames(captured))
	}
}

// TestLoggerServiceNameInMethod 对应 'uses service name when called from
// inside a Service method (regression)'：服务方法内经 this.ctx 输出日志，
// 名字取服务构造 fiber（'foo:driver'），不回落 root。
func TestLoggerServiceNameInMethod(t *testing.T) {
	ctxBg := context.Background()
	root, captured := loggerSetup()
	fiber, err := root.Plugin(loggerFooPlugin("foo:driver"), nil)
	if err != nil {
		t.Fatalf("装载 Foo 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Foo 失败：%v", err)
	}
	v, err := root.Get("foo")
	if err != nil {
		t.Fatalf("读取 foo 失败：%v", err)
	}
	foo, _ := v.(*loggerDriverFoo)
	if foo == nil {
		t.Fatalf("foo 服务类型不符：%T", v)
	}
	foo.Action(root)
	if !reflect.DeepEqual(loggerNames(captured), []string{"foo:driver"}) {
		t.Fatalf("消息名应为 foo:driver，实际 %v", loggerNames(captured))
	}
}

// TestLoggerOuterInterceptOverridesServiceName 对应 'still lets outer
// caller intercept override the service-derived name'：外层
// ctx.intercept('logger', ...) 沿 use-site 链覆盖服务派生名。
func TestLoggerOuterInterceptOverridesServiceName(t *testing.T) {
	ctxBg := context.Background()
	root, captured := loggerSetup()
	fiber, err := root.Plugin(loggerFooPlugin("foo:driver"), nil)
	if err != nil {
		t.Fatalf("装载 Foo 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Foo 失败：%v", err)
	}
	v, err := root.Get("foo")
	if err != nil {
		t.Fatalf("读取 foo 失败：%v", err)
	}
	foo, _ := v.(*loggerDriverFoo)
	if foo == nil {
		t.Fatalf("foo 服务类型不符：%T", v)
	}
	foo.Action(root.Intercept("logger", map[string]any{"name": "caller-override"}))
	names := loggerNames(captured)
	if !containsString(names, "caller-override") {
		t.Fatalf("消息名应含 caller-override，实际 %v", names)
	}
	if containsString(names, "foo:driver") {
		t.Fatalf("消息名不应再含 foo:driver，实际 %v", names)
	}
}

// TestLoggerInnermostServiceName 对应 'uses the innermost service name and
// restores the outer service'：内嵌服务调用各取其名、外层服务随后恢复
// 自己的名字，输出顺序与调用顺序一致。
func TestLoggerInnermostServiceName(t *testing.T) {
	ctxBg := context.Background()
	root, captured := loggerSetup()

	barPlugin := &Plugin{
		Name: "bar:driver",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &loggerDriverBar{}
			s.Service = newTestService(c, "bar", s, nil)
			return nil, nil
		},
	}
	fooPlugin := &Plugin{
		Name:   "foo:driver",
		Inject: InjectMap{"bar": nil},
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &loggerDriverFooBar{}
			s.Service = newTestService(c, "foo", s, nil)
			return nil, nil
		},
	}
	for _, p := range []*Plugin{barPlugin, fooPlugin} {
		fiber, err := root.Plugin(p, nil)
		if err != nil {
			t.Fatalf("装载 %s 失败：%v", p.Name, err)
		}
		if _, err := fiber.Await(ctxBg); err != nil {
			t.Fatalf("等待 %s 失败：%v", p.Name, err)
		}
	}

	fiber, err := root.Inject([]string{"foo"}, func(c *Context, _ any) (Disposable, error) {
		v, err := c.Get("foo")
		if err != nil {
			t.Errorf("注入 ctx 读取 foo 失败：%v", err)
			return nil, nil
		}
		foo, _ := v.(*loggerDriverFooBar)
		if foo == nil {
			t.Errorf("foo 服务类型不符：%T", v)
			return nil, nil
		}
		if err := foo.Action(c); err != nil {
			t.Errorf("foo.Action 失败：%v", err)
		}
		return nil, nil
	})
	if err != nil {
		t.Fatalf("inject 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 inject fiber 失败：%v", err)
	}

	got := make([][2]string, 0, len(*captured))
	for _, m := range *captured {
		got = append(got, [2]string{m.Name, m.Args[0].(string)})
	}
	want := [][2]string{
		{"bar:driver", "from bar"},
		{"foo:driver", "from foo"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("消息序列应为 %v，实际 %v", want, got)
	}
}

// TestLoggerServiceNameInInit 对应 'uses service name when called from
// inside [Service.init] (unchanged behaviour)'：fiber 激活体（init 的 Go
// 落点）内输出日志取服务名。
func TestLoggerServiceNameInInit(t *testing.T) {
	ctxBg := context.Background()
	root, captured := loggerSetup()
	initPlugin := &Plugin{
		Name: "foo:driver",
		Apply: func(c *Context, _ any) (Disposable, error) {
			s := &loggerDriverFoo{}
			s.Service = newTestService(c, "foo", s, nil)
			c.Logger().Debug("from init")
			return nil, nil
		},
	}
	fiber, err := root.Plugin(initPlugin, nil)
	if err != nil {
		t.Fatalf("装载 Foo 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 Foo 失败：%v", err)
	}
	if !containsString(loggerNames(captured), "foo:driver") {
		t.Fatalf("消息名应含 foo:driver，实际 %v", loggerNames(captured))
	}
}

// containsString 报告切片是否含指定字符串。
func containsString(list []string, target string) bool {
	for _, item := range list {
		if item == target {
			return true
		}
	}
	return false
}

// —— 方案 2.5 要求的自建单测 ——

// TestHyphenate 验证 cosmokit hyphenate 的 Go 等价实现：大写前插连字符
// 并转小写；服务名（含冒号、已连字符形态）原样。
func TestHyphenate(t *testing.T) {
	cases := map[string]string{
		"foo":        "foo",
		"fooBar":     "foo-bar",
		"FooBar":     "-foo-bar",
		"foo:driver": "foo:driver",
		"fooBarBaz":  "foo-bar-baz",
		"":           "",
	}
	for input, want := range cases {
		if got := hyphenate(input); got != want {
			t.Errorf("hyphenate(%q) 应为 %q，实际 %q", input, want, got)
		}
	}
}

// TestLoggerFormat 验证格式化行为：占位替换、%%、未知占位保留、剩余参数
// 追加（对象 JSON 化）、error 首参改写、非字符串首参前置 %o、行长截断。
func TestLoggerFormat(t *testing.T) {
	exporter := &loggerPlainExporter{}
	format := func(args ...any) string {
		return LoggerFormat(exporter, &Message{Name: "test", Args: args})
	}

	if got := format("值 %s 和 %d", "x", 7); got != "值 x 和 7" {
		t.Errorf("%%s/%%d 替换不符：%q", got)
	}
	if got := format("%d%%", 50); got != "50%" {
		t.Errorf("%%%% 转义不符：%q", got)
	}
	if got := format("%q"); got != "%q" {
		t.Errorf("未知占位应原样保留：%q", got)
	}
	if got := format("%f", "1.5"); got != "1.5" {
		t.Errorf("%%f 数值转换不符：%q", got)
	}
	if got := format("a", map[string]any{"foo": "bar"}); got != `a {"foo":"bar"}` {
		t.Errorf("剩余对象参数应 JSON 化追加：%q", got)
	}
	if got := format(errors.New("坏了")); got != "坏了" {
		t.Errorf("error 首参应改写为文案：%q", got)
	}
	if got := format(42); got != "42" {
		t.Errorf("非字符串首参应前置 %%o：%q", got)
	}
	length := 4
	exporter.SetOptions(ExporterConfig{MaxLength: &length})
	if got := format("abcdef"); got != "abcd..." {
		t.Errorf("超长行应截断加省略号：%q", got)
	}
	if got := format("ab\ncdefg"); got != "ab\ncdef..." {
		t.Errorf("截断应按行分别应用：%q", got)
	}
	zero := 0
	exporter.SetOptions(ExporterConfig{MaxLength: &zero})
	if got := format("abcdef"); got != "..." {
		t.Errorf("显式零截断：%q", got)
	}
	exporter.SetOptions(ExporterConfig{})
}

// TestLoggerCode 验证哈希取色：level 0 无色表返回 0；已知锚定值按 JS
// 人工推导（"a"：hash = 0*7 + 97 + 13 = 110；110%6=2 → C16[2]=3；
// 110%75=35 → C256[35]=134；"ab"：hash = 110*7 + 98 + 13 = 881；881%6=5
// → C16[5]=1）。
func TestLoggerCode(t *testing.T) {
	if got := LoggerCode("a", 0); got != 0 {
		t.Errorf("level 0 应无色码，实际 %d", got)
	}
	if got := LoggerCode("a", 1); got != 3 {
		t.Errorf(`LoggerCode("a", 1) 应为 3，实际 %d`, got)
	}
	if got := LoggerCode("a", 3); got != 134 {
		t.Errorf(`LoggerCode("a", 3) 应为 134，实际 %d`, got)
	}
	if got := LoggerCode("ab", 1); got != 1 {
		t.Errorf(`LoggerCode("ab", 1) 应为 1，实际 %d`, got)
	}
}

// TestLoggerColor 验证无色回退与 ANSI 序列形态。
func TestLoggerColor(t *testing.T) {
	plain := &loggerPlainExporter{}
	if got := LoggerColor(plain, 6, "文本", ""); got != "文本" {
		t.Errorf("无色导出器应返回原值字符串，实际 %q", got)
	}
	colored := &loggerPlainExporter{}
	colored.SetOptions(ExporterConfig{Colors: 1})
	if got := LoggerColor(colored, 6, "文本", ""); got != "\u001b[36m文本\u001b[0m" {
		t.Errorf("基本色序列不符：%q", got)
	}
	colored.SetOptions(ExporterConfig{Colors: 3})
	// TS 模板 `\u001b[3${code<8?code:'8;5;'+code}${decoration}m` 对 256 色
	// 与装饰是直接拼接（无分号），照 TS 输出断言。
	if got := LoggerColor(colored, 200, "文本", "1"); got != "\u001b[38;5;2001m文本\u001b[0m" {
		t.Errorf("256 色带装饰序列不符：%q", got)
	}
}

// TestLoggerErrorUnwrapping 验证 error 参数的 cause/聚合展开顺序：
// cause 先展开后仍输出原错误；聚合展开各子错误且不输出聚合本身。
func TestLoggerErrorUnwrapping(t *testing.T) {
	root := NewContext()
	s := root.LoggerService()
	s.mu.Lock()
	s.exporters = make(map[int64]Exporter)
	s.order = nil
	s.mu.Unlock()
	captured := &[]*Message{}
	e := &loggerCaptureExporter{captured: captured}
	e.SetOptions(ExporterConfig{Levels: map[string]int{"default": 3}})
	s.Exporter(root, e)

	base := errors.New("根因")
	wrapped := fmt.Errorf("包装: %w", base)
	agg := &AggregateError{Errors: []error{errors.New("甲"), errors.New("乙")}}

	root.Logger().Error(wrapped)
	if len(*captured) != 2 {
		t.Fatalf("cause 展开应输出 2 条（cause 与原错误），实际 %d", len(*captured))
	}
	if got := (*captured)[0].Args[0].(error).Error(); got != "根因" {
		t.Errorf("首条应为 cause，实际 %q", got)
	}
	if got := (*captured)[1].Args[0].(error).Error(); got != wrapped.Error() {
		t.Errorf("次条应为原错误，实际 %q", got)
	}

	*captured = (*captured)[:0]
	root.Logger().Error(agg)
	if len(*captured) != 2 {
		t.Fatalf("聚合展开应输出 2 条子错误，实际 %d", len(*captured))
	}
	if got := (*captured)[0].Args[0].(error).Error(); got != "甲" || (*captured)[1].Args[0].(error).Error() != "乙" {
		t.Errorf("聚合子错误顺序不符：%q %q", (*captured)[0].Args[0], (*captured)[1].Args[0])
	}
}

type loggerFuncExporter struct {
	ExporterBase
	fn func(*Message)
}

func (e *loggerFuncExporter) Export(m *Message) { e.fn(m) }

type loggerBrokenOptions struct{ loggerPlainExporter }

func (*loggerBrokenOptions) Options() *ExporterConfig { panic("配置读取失败") }

func TestLoggerExporterPanicIsolated(t *testing.T) {
	root := NewContext()
	for _, exporter := range []Exporter{
		&loggerFuncExporter{fn: func(*Message) { panic("写入失败") }},
		&loggerBrokenOptions{},
	} {
		if _, err := root.LoggerService().Exporter(root, exporter); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if _, err := root.LoggerService().Exporter(root, &loggerFuncExporter{fn: func(*Message) { count++ }}); err != nil {
		t.Fatal(err)
	}
	root.Logger("test").Info("原消息")
	if count != 1 {
		t.Fatalf("失败导出器阻断了后续派发：%d", count)
	}
	messages := root.LoggerService().Messages()
	if len(messages) != 3 {
		t.Fatalf("应记录原消息及两个导出器错误，实际 %d", len(messages))
	}
	for _, message := range messages[1:] {
		if message.Type != LoggerTypeError || !strings.Contains(fmt.Sprint(message.Args...), "日志导出器发生 panic") {
			t.Fatalf("失败不可观察：%+v", message)
		}
	}
}

func TestLoggerMessageSnapshotsAreIndependent(t *testing.T) {
	root := NewContext()
	payload := map[string]any{"nested": []any{map[string]string{"value": "原值"}}}
	mutate := &loggerFuncExporter{fn: func(m *Message) {
		m.Args[0].(map[string]any)["nested"].([]any)[0].(map[string]string)["value"] = "导出器变更"
		m.Args[0] = "替换参数"
	}}
	var captured *Message
	capture := &loggerFuncExporter{fn: func(m *Message) { captured = m }}
	if _, err := root.LoggerService().Exporter(root, mutate); err != nil {
		t.Fatal(err)
	}
	if _, err := root.LoggerService().Exporter(root, capture); err != nil {
		t.Fatal(err)
	}
	root.Logger("test").Info(payload)
	read := func(m *Message) string {
		return m.Args[0].(map[string]any)["nested"].([]any)[0].(map[string]string)["value"]
	}
	if got := read(captured); got != "原值" {
		t.Fatalf("前一个导出器污染后一个：%s", got)
	}
	payload["nested"].([]any)[0].(map[string]string)["value"] = "调用方变更"
	messages := root.LoggerService().Messages()
	if got := read(messages[0]); got != "原值" {
		t.Fatalf("调用方变更污染缓冲：%s", got)
	}
	messages[0].Args[0].(map[string]any)["nested"].([]any)[0].(map[string]string)["value"] = "快照变更"
	if got := read(root.LoggerService().Messages()[0]); got != "原值" {
		t.Fatalf("快照变更污染缓冲：%s", got)
	}
	original := &Message{Meta: map[string]any{"data": []int{1}}}
	clone := cloneMessage(original)
	clone.Meta["data"].([]int)[0] = 2
	if original.Meta["data"].([]int)[0] != 1 {
		t.Fatal("Meta 没有独立复制")
	}
}

func TestLoggerSnapshotCircularContainers(t *testing.T) {
	root := NewContext()
	payload := map[string]any{}
	payload["self"] = payload
	payload["value"] = "原值"
	root.Logger().Info(payload)
	copy := root.LoggerService().Messages()[0].Args[0].(map[string]any)
	copy["self"].(map[string]any)["value"] = "快照"
	if copy["value"] != "快照" {
		t.Fatal("循环容器身份未保留")
	}
	if payload["value"] != "原值" {
		t.Fatal("循环快照仍引用输入")
	}
}

func TestLoggerExporterOptionsSnapshots(t *testing.T) {
	base := &ExporterBase{}
	input := ExporterConfig{Levels: map[string]int{"default": 2}, Formatters: map[string]Formatter{"x": func(any, Exporter, *Message) any { return "x" }}}
	base.SetOptions(input)
	input.Levels["default"] = 0
	delete(input.Formatters, "x")
	first := base.Options()
	if first.Levels["default"] != 2 || first.Formatters["x"] == nil {
		t.Fatal("调用方修改影响导出器配置")
	}
	first.Levels["default"] = 1
	delete(first.Formatters, "x")
	second := base.Options()
	if second.Levels["default"] != 2 || second.Formatters["x"] == nil {
		t.Fatal("快照修改影响导出器配置")
	}
}

func TestLoggerConcurrentOptionsAndBufferSnapshots(t *testing.T) {
	root := NewContext()
	base := &loggerPlainExporter{}
	if _, err := root.LoggerService().Exporter(root, base); err != nil {
		t.Fatal(err)
	}
	const count = 100
	root.LoggerService().SetBufferSize(count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			base.SetOptions(ExporterConfig{Colors: n % 4, Levels: map[string]int{"default": 3}})
			root.Logger().Info(map[string]int{"index": n})
			for _, message := range root.LoggerService().Messages() {
				message.Args[0].(map[string]int)["index"] = -1
			}
		}(i)
	}
	wg.Wait()
	messages := root.LoggerService().Messages()
	if len(messages) != count {
		t.Fatalf("并发日志丢失：%d", len(messages))
	}
	for i, message := range messages {
		if message.Args[0].(map[string]int)["index"] == -1 {
			t.Fatal("并发快照污染缓冲")
		}
		if i > 0 && messages[i-1].SN >= message.SN {
			t.Fatal("并发消息序号乱序")
		}
	}
}
