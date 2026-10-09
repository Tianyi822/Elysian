// sync_test.go 对应 include/tests/sync.spec.ts 的 16 个用例（race 两个次序
// 各算一个），harness 是 TS tests/utils.ts 的等价物：起 loader、挂 include、
// 收集日志消息；settle = refresh + loader.await + 任务收敛。chmod 只读用例
// 以 FileOps.Writable 注入替代（root 权限下 chmod 不可靠）。
package include

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/kardia/clock"
	"elysian/server/internal/agent/kardia/loader"
)

// —— fixture 插件（编译期注册替代 Node 模块解析）——

var (
	includePluginsOnce sync.Once
	appliedMu          sync.Mutex
	appliedTags        []string
)

func noteConfigApplied(tag any) {
	appliedMu.Lock()
	appliedTags = append(appliedTags, fmt.Sprint(tag))
	appliedMu.Unlock()
}

func appliedCount(tag string) int {
	appliedMu.Lock()
	defer appliedMu.Unlock()
	n := 0
	for _, item := range appliedTags {
		if item == tag {
			n++
		}
	}
	return n
}

func registerIncludePlugins() {
	includePluginsOnce.Do(func() {
		loader.RegisterFunc("./config-plugin", func(ctx *kardia.Context, config any) (kardia.Disposable, error) {
			var tag any
			if m, ok := config.(map[string]any); ok {
				tag = m["tag"]
			}
			noteConfigApplied(tag)
			off, err := ctx.On(kardia.StringEvent("test/config"), func(ev *kardia.EventCtx) (any, error) {
				if len(ev.Args) > 0 && ev.Args[0] == tag {
					return config, nil
				}
				return nil, nil
			})
			if err != nil {
				return nil, err
			}
			return func(context.Context) error {
				off()
				return nil
			}, nil
		})
		loader.RegisterFunc("./test-plugin", func(ctx *kardia.Context, config any) (kardia.Disposable, error) {
			off, err := ctx.On(kardia.StringEvent("test/get-value"), func(ev *kardia.EventCtx) (any, error) {
				return "default", nil
			})
			if err != nil {
				return nil, err
			}
			return func(context.Context) error {
				off()
				return nil
			}, nil
		})
		loader.RegisterFunc("./extra-plugin", func(ctx *kardia.Context, config any) (kardia.Disposable, error) {
			off, err := ctx.On(kardia.StringEvent("test/get-extra"), func(ev *kardia.EventCtx) (any, error) {
				return "extra", nil
			})
			if err != nil {
				return nil, err
			}
			return func(context.Context) error {
				off()
				return nil
			}, nil
		})
		loader.Register("@cordisjs/plugin-group", loader.Group)
		loader.Register("@cordisjs/plugin-include", Plugin)
	})
}

// typedExporter 收集全部日志消息（含类型），供分级断言。
type typedExporter struct {
	kardia.ExporterBase
	mu       sync.Mutex
	messages []kardia.Message
}

func (e *typedExporter) Export(m *kardia.Message) {
	e.mu.Lock()
	e.messages = append(e.messages, *m)
	e.mu.Unlock()
}

func (e *typedExporter) logs(typ kardia.LoggerType) []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []string
	for i := range e.messages {
		if e.messages[i].Type == typ {
			out = append(out, fmt.Sprint(e.messages[i].Args...))
		}
	}
	return out
}

// includeHarness 对应 TS harness()（tests/utils.ts:29-83）。
type includeHarness struct {
	t        *testing.T
	ctx      *kardia.Context
	clk      *clock.Manual
	fiber    *kardia.Fiber
	loader   *loader.Loader
	id       string
	filename string
	exporter *typedExporter
}

// cfgPlugin 对应 tests/utils.ts 的 plugin(id, value)。
func cfgPlugin(id string, value int) *loader.EntryOptions {
	return &loader.EntryOptions{ID: id, Name: "./config-plugin", Config: map[string]any{"tag": id, "value": value}}
}

// cfgGroup 对应 tests/utils.ts 的 group(id, config)。
func cfgGroup(id string, config []*loader.EntryOptions) *loader.EntryOptions {
	return &loader.EntryOptions{ID: id, Name: "@cordisjs/plugin-group", Group: bptr(true), Config: config}
}

// setupInclude 写初始文件并启动 loader+include，最后做一次 settle。
func setupInclude(t *testing.T, name string, data any, mutate func(*Config)) *includeHarness {
	t.Helper()
	registerIncludePlugins()
	dir := t.TempDir()
	filename := filepath.Join(dir, name)
	text, ok := data.(string)
	if !ok {
		entries, _ := loader.AsEntries(data)
		text = mustDumpYAML(t, entries)
	}
	if err := os.WriteFile(filename, []byte(text), 0o644); err != nil {
		t.Fatalf("写入初始文件失败：%v", err)
	}

	clk := clock.NewManual(testBaseTime)
	ctx := kardia.NewContext(kardia.WithClock(clk))
	exporter := &typedExporter{}
	ctx.LoggerService().Exporter(ctx, exporter)
	fiber, err := ctx.Plugin(loader.Plugin, nil)
	if err != nil {
		t.Fatalf("装载 loader 失败：%v", err)
	}
	// fiber 加载异步，Get 前先等惯性排空，否则 loose 路径静默返回 nil。
	if _, err := fiber.Await(context.Background()); err != nil {
		t.Fatalf("等待 loader 插件激活失败：%v", err)
	}
	lv, err := ctx.Get("loader")
	if err != nil {
		t.Fatalf("解析 loader 服务失败：%v", err)
	}
	l, _ := lv.(*loader.Loader)

	cfg := Config{Path: filename}
	if mutate != nil {
		mutate(&cfg)
	}
	id, err := l.Create(context.Background(), loader.EntryOptions{Name: Plugin.Name, Config: cfg}, nil, 0)
	if err != nil {
		t.Fatalf("创建 include 失败：%v", err)
	}
	if err := l.Await(context.Background()); err != nil {
		t.Fatalf("等待树就绪失败：%v", err)
	}

	h := &includeHarness{
		t: t, ctx: ctx, clk: clk, fiber: fiber,
		loader: l, id: id, filename: filename, exporter: exporter,
	}
	t.Cleanup(func() { h.dispose() })
	h.settle()
	return h
}

// include 取（外层）include 服务的当前实例。
func (h *includeHarness) include() *Include {
	e, err := h.loader.Resolve(h.id)
	if err != nil {
		h.t.Fatalf("解析 include 条目失败：%v", err)
	}
	inc := IncludeOf(e.Subtree())
	if inc == nil {
		h.t.Fatal("include 条目缺少子树")
	}
	return inc
}

// settle 对应 TS 的 settle：refresh + loader.await（Go 侧追加任务收敛）。
func (h *includeHarness) settle() {
	h.t.Helper()
	if err := h.include().Refresh(context.Background()); err != nil {
		h.t.Fatalf("refresh 失败：%v", err)
	}
	if err := h.loader.Await(context.Background()); err != nil {
		h.t.Fatalf("等待树失败：%v", err)
	}
	if err := h.ctx.Tasks().Wait(context.Background()); err != nil {
		h.t.Fatalf("等待任务失败：%v", err)
	}
}

// update 对应 app.update(local, options)：复合 id = 外层 id + local。
func (h *includeHarness) update(local string, opts loader.EntryOptions) error {
	return h.loader.Update(context.Background(), h.id+":"+local, loader.PatchOptions(opts), nil, nil)
}

// writeFile 以外部编辑者身份改写文件（不经 FileOps）。
func (h *includeHarness) writeFile(text string) {
	h.t.Helper()
	if err := os.WriteFile(h.filename, []byte(text), 0o644); err != nil {
		h.t.Fatalf("写入文件失败：%v", err)
	}
}

// text 读当前文件内容。
func (h *includeHarness) text() string {
	data, err := os.ReadFile(h.filename)
	if err != nil {
		h.t.Fatalf("读取文件失败：%v", err)
	}
	return string(data)
}

// readEntries 重新解析文件为条目列表（app.read 的等价物）。
func (h *includeHarness) readEntries() []*loader.EntryOptions {
	h.t.Helper()
	data, err := os.ReadFile(h.filename)
	if err != nil {
		h.t.Fatalf("读取文件失败：%v", err)
	}
	v, err := parseYAMLDoc(data)
	if err != nil {
		h.t.Fatalf("解析文件失败：%v", err)
	}
	entries, ok := loader.AsEntries(v)
	if !ok {
		h.t.Fatal("文件应解析为条目数组")
	}
	return entries
}

// configValue 对应 app.config(tag)：以 bail 取活跃插件配置。
func (h *includeHarness) configValue(tag string) map[string]any {
	v, err := h.ctx.Bail(kardia.StringEvent("test/config"), tag)
	if err != nil {
		h.t.Fatalf("bail test/config 失败：%v", err)
	}
	if v == nil {
		return nil
	}
	m, _ := v.(map[string]any)
	return m
}

// bailValue 以 bail 取字符串事件值（test/get-value 等）。
func (h *includeHarness) bailValue(name string) any {
	v, err := h.ctx.Bail(kardia.StringEvent(name))
	if err != nil {
		h.t.Fatalf("bail %s 失败：%v", name, err)
	}
	return v
}

// logs 按级别取日志文案。
func (h *includeHarness) logs(typ kardia.LoggerType) []string {
	return h.exporter.logs(typ)
}

// dispose 卸载 loader fiber 并收敛任务（app.dispose）。
func (h *includeHarness) dispose() {
	_ = h.fiber.Dispose(context.Background())
	_ = h.ctx.Tasks().Wait(context.Background())
}

// toggleOps 是可切换只读的 FileOps（chmod 用例的替代）。
type toggleOps struct {
	osFileOps
	mu       sync.Mutex
	writable bool
}

func (o *toggleOps) setWritable(w bool) {
	o.mu.Lock()
	o.writable = w
	o.mu.Unlock()
}

func (o *toggleOps) Writable(path string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.writable
}

func mustConfigValue(t *testing.T, m map[string]any, key string) any {
	t.Helper()
	if m == nil {
		t.Fatalf("配置缺失，期望键 %s", key)
	}
	return m[key]
}

// —— sync.spec.ts 的用例 ——

func TestSyncCoalescesConsecutiveWrites(t *testing.T) {
	h := setupInclude(t, "tmp-sync-coalesce.yml", []*loader.EntryOptions{cfgPlugin("a", 1)}, nil)
	for _, value := range []int{2, 3, 4} {
		if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": value}}); err != nil {
			t.Fatalf("更新 a 失败：%v", err)
		}
	}
	h.settle()
	if got := mustConfigValue(t, h.configValue("a"), "value"); got != 4 {
		t.Fatalf("树侧应收敛到最新值 4，实际 %v", got)
	}
	if got := mustConfigValue(t, readConfig(t, h.readEntries()[0]), "value"); got != 4 {
		t.Fatalf("文件应写入最新值 4，实际 %v", got)
	}
	if errors := h.logs(kardia.LoggerTypeError); len(errors) != 0 {
		t.Fatalf("不应有错误日志，实际 %v", errors)
	}
}

func TestSyncRefreshInsideWrite(t *testing.T) {
	h := setupInclude(t, "tmp-sync-window.yml", []*loader.EntryOptions{cfgPlugin("a", 1)}, nil)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_ = h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}})
	}()
	go func() {
		defer wg.Done()
		_ = h.include().Refresh(context.Background())
	}()
	wg.Wait()
	h.settle()
	if got := mustConfigValue(t, h.configValue("a"), "value"); got != 2 {
		t.Fatalf("树侧应为 2，实际 %v", got)
	}
	if got := mustConfigValue(t, readConfig(t, h.readEntries()[0]), "value"); got != 2 {
		t.Fatalf("文件应为 2，实际 %v", got)
	}
}

func TestSyncNoWriteBackWhenFileRemovesEntry(t *testing.T) {
	before := "# keep me\n" + mustDumpYAML(t, []*loader.EntryOptions{cfgPlugin("a", 1), cfgPlugin("b", 1)})
	h := setupInclude(t, "tmp-sync-remove.yml", before, nil)
	if h.configValue("b") == nil {
		t.Fatal("b 应已装载")
	}
	after := "# keep me\n" + mustDumpYAML(t, []*loader.EntryOptions{cfgPlugin("a", 1)})
	h.writeFile(after)
	h.settle()
	if h.configValue("b") != nil {
		t.Fatal("文件移除的条目应从树中消失")
	}
	if got := h.text(); got != after {
		t.Fatalf("文件不应被改写，实际 %q", got)
	}
	if errors := h.logs(kardia.LoggerTypeError); len(errors) != 0 {
		t.Fatalf("不应有错误日志，实际 %v", errors)
	}
}

func TestSyncNoWriteBackWhenFileDisablesEntry(t *testing.T) {
	h := setupInclude(t, "tmp-sync-disable.yml", "# keep me\n"+mustDumpYAML(t, []*loader.EntryOptions{cfgPlugin("a", 1)}), nil)
	disabled := cfgPlugin("a", 1)
	disabled.Disabled = bptr(true)
	after := "# keep me\n" + mustDumpYAML(t, []*loader.EntryOptions{disabled})
	h.writeFile(after)
	h.settle()
	if h.configValue("a") != nil {
		t.Fatal("文件禁用的条目应被卸载")
	}
	if got := h.text(); got != after {
		t.Fatalf("文件不应被改写，实际 %q", got)
	}
}

func TestSyncMergesFileEditAndRuntimeEdit(t *testing.T) {
	h := setupInclude(t, "tmp-sync-merge.yml", []*loader.EntryOptions{cfgPlugin("a", 1), cfgPlugin("b", 1)}, nil)
	// 文件在无观察者告知的情况下被外部修改
	h.writeFile(mustDumpYAML(t, []*loader.EntryOptions{cfgPlugin("a", 1), cfgPlugin("b", 2)}))
	if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}}); err != nil {
		t.Fatalf("更新 a 失败：%v", err)
	}
	h.settle()
	if got := mustConfigValue(t, h.configValue("a"), "value"); got != 2 {
		t.Fatalf("a 应为 2，实际 %v", got)
	}
	if got := mustConfigValue(t, h.configValue("b"), "value"); got != 2 {
		t.Fatalf("b 应为 2，实际 %v", got)
	}
	entries := h.readEntries()
	if got := mustConfigValue(t, readConfig(t, entries[0]), "value"); got != 2 {
		t.Fatalf("文件 a 应为 2，实际 %v", got)
	}
	if got := mustConfigValue(t, readConfig(t, entries[1]), "value"); got != 2 {
		t.Fatalf("文件 b 应为 2，实际 %v", got)
	}
	if errors := h.logs(kardia.LoggerTypeError); len(errors) != 0 {
		t.Fatalf("不应有错误日志，实际 %v", errors)
	}
}

// 两个次序的竞态用例：webui 保存条目 A、编辑器保存条目 B 且 watcher 触发，
// 无论谁先到，两侧编辑都存活。
func TestSyncRacingFileEditAndRuntimeEdit(t *testing.T) {
	for _, order := range []string{"refresh first", "update first"} {
		t.Run(order, func(t *testing.T) {
			name := "tmp-sync-race-" + strings.ReplaceAll(order, " ", "-") + ".yml"
			h := setupInclude(t, name, []*loader.EntryOptions{cfgPlugin("a", 1), cfgPlugin("b", 1)}, nil)
			h.writeFile(mustDumpYAML(t, []*loader.EntryOptions{cfgPlugin("a", 1), cfgPlugin("b", 2)}))
			var wg sync.WaitGroup
			if order == "refresh first" {
				wg.Add(2)
				go func() {
					defer wg.Done()
					_ = h.include().Refresh(context.Background())
				}()
				go func() {
					defer wg.Done()
					_ = h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}})
				}()
			} else {
				wg.Add(2)
				go func() {
					defer wg.Done()
					_ = h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}})
				}()
				go func() {
					defer wg.Done()
					_ = h.include().Refresh(context.Background())
				}()
			}
			wg.Wait()
			h.settle()
			if got := mustConfigValue(t, h.configValue("a"), "value"); got != 2 {
				t.Fatalf("a 应为 2，实际 %v", got)
			}
			if got := mustConfigValue(t, h.configValue("b"), "value"); got != 2 {
				t.Fatalf("b 应为 2，实际 %v", got)
			}
			entries := h.readEntries()
			if got := mustConfigValue(t, readConfig(t, entries[0]), "value"); got != 2 {
				t.Fatalf("文件 a 应为 2，实际 %v", got)
			}
			if got := mustConfigValue(t, readConfig(t, entries[1]), "value"); got != 2 {
				t.Fatalf("文件 b 应为 2，实际 %v", got)
			}
			if errors := h.logs(kardia.LoggerTypeError); len(errors) != 0 {
				t.Fatalf("不应有错误日志，实际 %v", errors)
			}
		})
	}
}

func TestSyncFileWinsConflictAndReports(t *testing.T) {
	h := setupInclude(t, "tmp-sync-conflict.yml", []*loader.EntryOptions{cfgPlugin("a", 1)}, nil)
	h.writeFile(mustDumpYAML(t, []*loader.EntryOptions{cfgPlugin("a", 3)}))
	if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}}); err != nil {
		t.Fatalf("更新 a 失败：%v", err)
	}
	h.settle()
	if got := mustConfigValue(t, h.configValue("a"), "value"); got != 3 {
		t.Fatalf("冲突应以文件为准（3），实际 %v", got)
	}
	if got := mustConfigValue(t, readConfig(t, h.readEntries()[0]), "value"); got != 3 {
		t.Fatalf("文件应为 3，实际 %v", got)
	}
	errors := h.logs(kardia.LoggerTypeError)
	if len(errors) != 1 {
		t.Fatalf("应恰好报告一次冲突，实际 %v", errors)
	}
	if !strings.Contains(errors[0], "冲突") || !strings.Contains(errors[0], "配置") {
		t.Fatalf("冲突报告应含配置与冲突字样，实际 %q", errors[0])
	}
}

func TestSyncCombinesFileMoveWithRuntimeEdit(t *testing.T) {
	h := setupInclude(t, "tmp-sync-move.yml", []*loader.EntryOptions{cfgPlugin("a", 1), cfgGroup("g", nil)}, nil)
	h.writeFile(mustDumpYAML(t, []*loader.EntryOptions{cfgGroup("g", []*loader.EntryOptions{cfgPlugin("a", 1)})}))
	if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}}); err != nil {
		t.Fatalf("更新 a 失败：%v", err)
	}
	h.settle()
	inc := h.include()
	if inc.Entry("a") == nil || inc.Entry("g") == nil || inc.Entry("a").Parent() != inc.Entry("g").Subgroup() {
		t.Fatal("a 应迁入 g 的成员组")
	}
	if got := mustConfigValue(t, h.configValue("a"), "value"); got != 2 {
		t.Fatalf("a 应为 2，实际 %v", got)
	}
	entries := h.readEntries()
	if entries[0].ID != "g" {
		t.Fatalf("文件首个条目应为 g，实际 %q", entries[0].ID)
	}
	list, ok := listOf(entries[0])
	if !ok || len(list) != 1 || list[0].ID != "a" {
		t.Fatalf("g 的成员应为 [a]，实际 %v", list)
	}
	if got := mustConfigValue(t, readConfig(t, list[0]), "value"); got != 2 {
		t.Fatalf("迁移随行的编辑应为 2，实际 %v", got)
	}
	if errors := h.logs(kardia.LoggerTypeError); len(errors) != 0 {
		t.Fatalf("不应有错误日志，实际 %v", errors)
	}
}

func TestSyncNeverWritesOverUnparsableFile(t *testing.T) {
	h := setupInclude(t, "tmp-sync-broken.yml", []*loader.EntryOptions{cfgPlugin("a", 1)}, nil)
	h.writeFile("- {\n")
	if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}}); err != nil {
		t.Fatalf("更新 a 失败：%v", err)
	}
	if err := h.include().Refresh(context.Background()); err == nil {
		t.Fatal("refresh 应返回无效文件错误")
	}
	warns := h.logs(kardia.LoggerTypeWarn)
	if !logsContain(warns, "无法解析") {
		t.Fatalf("应告警解析失败，实际 %v", warns)
	}
	if got := h.text(); got != "- {\n" {
		t.Fatalf("坏文件应原样保留，实际 %q", got)
	}
	if got := mustConfigValue(t, h.configValue("a"), "value"); got != 2 {
		t.Fatalf("运行时变更应保留在内存，实际 %v", got)
	}

	// 文件恢复有效后，待写变更随调和一起落盘
	h.writeFile(mustDumpYAML(t, []*loader.EntryOptions{cfgPlugin("a", 1), cfgPlugin("b", 1)}))
	h.settle()
	entries := h.readEntries()
	if got := mustConfigValue(t, readConfig(t, entries[0]), "value"); got != 2 {
		t.Fatalf("恢复后 a 应写入 2，实际 %v", got)
	}
	if got := mustConfigValue(t, readConfig(t, entries[1]), "value"); got != 1 {
		t.Fatalf("b 应保持 1，实际 %v", got)
	}
	if got := mustConfigValue(t, h.configValue("b"), "value"); got != 1 {
		t.Fatalf("树侧 b 应为 1，实际 %v", got)
	}
}

func TestSyncRoutesPatchOwnedKeysToParentConfig(t *testing.T) {
	dir := t.TempDir()
	inner := filepath.Join(dir, "tmp-sync-inner-patch.yml")
	innerText := mustDumpYAML(t, []*loader.EntryOptions{cfgPlugin("a", 1)})
	if err := os.WriteFile(inner, []byte(innerText), 0o644); err != nil {
		t.Fatalf("写入内层文件失败：%v", err)
	}
	h := setupInclude(t, "tmp-sync-outer-patch.yml", []*loader.EntryOptions{{
		ID:   "inc",
		Name: Plugin.Name,
		Config: map[string]any{
			"path":    inner,
			"patches": []any{map[string]any{"id": "a", "disabled": true}},
		},
	}}, nil)
	innerInclude := func() *Include {
		e, err := h.loader.Resolve(h.id)
		if err != nil {
			t.Fatalf("解析外层条目失败：%v", err)
		}
		outer := IncludeOf(e.Subtree())
		if outer == nil {
			t.Fatal("外层条目缺少子树")
		}
		return IncludeOf(outer.Entry("inc").Subtree())
	}
	if err := innerInclude().Refresh(context.Background()); err != nil {
		t.Fatalf("内层 refresh 失败：%v", err)
	}
	if h.configValue("a") != nil {
		t.Fatal("被补丁禁用的条目不应装载")
	}

	if err := h.update("inc:a", loader.EntryOptions{Disabled: bptr(false)}); err != nil {
		t.Fatalf("更新 inc:a 失败：%v", err)
	}
	if err := innerInclude().Refresh(context.Background()); err != nil {
		t.Fatalf("内层 refresh 失败：%v", err)
	}
	h.settle()
	if got := mustConfigValue(t, h.configValue("a"), "value"); got != 1 {
		t.Fatalf("a 应恢复装载（值 1），实际 %v", got)
	}
	if data, err := os.ReadFile(inner); err != nil || string(data) != innerText {
		t.Fatalf("内层文件不应被改写，实际 (%q, %v)", string(data), err)
	}
	entry := h.readEntries()[0]
	cfg := readConfig(t, entry)
	patches, ok := cfg["patches"].([]any)
	if !ok || len(patches) != 1 {
		t.Fatalf("外层配置应保留一个补丁，实际 %v", cfg["patches"])
	}
	patch, _ := patches[0].(map[string]any)
	if patch["id"] != "a" || patch["disabled"] != false {
		t.Fatalf("变更应路由回补丁（disabled=false），实际 %v", patch)
	}
	if errors := h.logs(kardia.LoggerTypeError); len(errors) != 0 {
		t.Fatalf("不应有错误日志，实际 %v", errors)
	}
}

func TestSyncRoutesInsertedEntriesToTheirPatch(t *testing.T) {
	dir := t.TempDir()
	inner := filepath.Join(dir, "tmp-sync-inner-insert.yml")
	innerText := mustDumpYAML(t, []*loader.EntryOptions{cfgPlugin("a", 1)})
	if err := os.WriteFile(inner, []byte(innerText), 0o644); err != nil {
		t.Fatalf("写入内层文件失败：%v", err)
	}
	h := setupInclude(t, "tmp-sync-outer-insert.yml", []*loader.EntryOptions{{
		ID:   "inc",
		Name: Plugin.Name,
		Config: map[string]any{
			"path": inner,
			"patches": []any{map[string]any{
				"insert": []any{map[string]any{
					"id":     "x",
					"name":   "./config-plugin",
					"config": map[string]any{"tag": "x", "value": 1},
				}},
			}},
		},
	}}, nil)
	innerInclude := func() *Include {
		e, _ := h.loader.Resolve(h.id)
		return IncludeOf(IncludeOf(e.Subtree()).Entry("inc").Subtree())
	}
	if err := innerInclude().Refresh(context.Background()); err != nil {
		t.Fatalf("内层 refresh 失败：%v", err)
	}
	if err := h.loader.Await(context.Background()); err != nil {
		t.Fatalf("等待树失败：%v", err)
	}
	if got := mustConfigValue(t, h.configValue("x"), "value"); got != 1 {
		t.Fatalf("插入条目应装载（值 1），实际 %v", got)
	}

	if err := h.update("inc:x", loader.EntryOptions{Config: map[string]any{"tag": "x", "value": 2}}); err != nil {
		t.Fatalf("更新 inc:x 失败：%v", err)
	}
	if err := innerInclude().Refresh(context.Background()); err != nil {
		t.Fatalf("内层 refresh 失败：%v", err)
	}
	h.settle()
	if got := mustConfigValue(t, h.configValue("x"), "value"); got != 2 {
		t.Fatalf("x 应为 2，实际 %v", got)
	}
	if data, err := os.ReadFile(inner); err != nil || string(data) != innerText {
		t.Fatalf("内层文件不应被改写，实际 (%q, %v)", string(data), err)
	}
	entry := h.readEntries()[0]
	cfg := readConfig(t, entry)
	patches, _ := cfg["patches"].([]any)
	if len(patches) != 1 {
		t.Fatalf("外层配置应保留一个补丁，实际 %v", cfg["patches"])
	}
	patch, _ := patches[0].(map[string]any)
	insert, _ := patch["insert"].([]any)
	if len(insert) != 1 {
		t.Fatalf("补丁应保留一个插入条目，实际 %v", patch)
	}
	inserted, _ := insert[0].(map[string]any)
	iconfig, _ := inserted["config"].(map[string]any)
	if iconfig == nil || iconfig["value"] != 2 {
		t.Fatalf("插入条目的变更应路由回补丁（值 2），实际 %v", inserted)
	}
}

func TestSyncKeepsAnonymousEntriesStable(t *testing.T) {
	anonymous := &loader.EntryOptions{Name: "./config-plugin", Config: map[string]any{"tag": "anon", "value": 1}}
	text := mustDumpYAML(t, []*loader.EntryOptions{anonymous, cfgPlugin("b", 1)})
	h := setupInclude(t, "tmp-sync-anonymous.yml", text, nil)
	if got := mustConfigValue(t, h.configValue("anon"), "value"); got != 1 {
		t.Fatalf("匿名条目应装载（值 1），实际 %v", got)
	}
	if got := h.text(); got != text {
		t.Fatalf("未发生变更时文件不应被改写，实际 %q", got)
	}
	applies := appliedCount("anon")

	edited := mustDumpYAML(t, []*loader.EntryOptions{anonymous, cfgPlugin("b", 2)})
	h.writeFile(edited)
	h.settle()
	if got := mustConfigValue(t, h.configValue("b"), "value"); got != 2 {
		t.Fatalf("b 应为 2，实际 %v", got)
	}
	if got := appliedCount("anon"); got != applies {
		t.Fatalf("编辑邻居不应重启匿名条目，实际 %d 次（原 %d 次）", got, applies)
	}
	if got := h.text(); got != edited {
		t.Fatalf("文件应保持外部编辑原样，实际 %q", got)
	}

	// 已分配的 id 随下一次写盘落进文件
	if err := h.update("b", loader.EntryOptions{Config: map[string]any{"tag": "b", "value": 3}}); err != nil {
		t.Fatalf("更新 b 失败：%v", err)
	}
	h.settle()
	first := h.readEntries()[0]
	if !regexp.MustCompile(`^[0-9a-f]{8}$`).MatchString(first.ID) {
		t.Fatalf("匿名条目应获得 8 位 hex id，实际 %q", first.ID)
	}
	if got := mustConfigValue(t, readConfig(t, first), "tag"); got != "anon" {
		t.Fatalf("首个条目应为匿名条目，实际 %v", got)
	}
}

func TestSyncKeepsRuntimeChangesInMemoryWhenReadOnly(t *testing.T) {
	h := setupInclude(t, "tmp-sync-readonly.yml", []*loader.EntryOptions{cfgPlugin("a", 1), cfgPlugin("b", 1)}, nil)
	text := h.text()
	ops := &toggleOps{}
	h.include().SetFileOps(ops)
	ops.setWritable(false)

	if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}}); err != nil {
		t.Fatalf("更新 a 失败：%v", err)
	}
	h.settle()
	if got := mustConfigValue(t, h.configValue("a"), "value"); got != 2 {
		t.Fatalf("运行时变更应生效，实际 %v", got)
	}
	if got := h.text(); got != text {
		t.Fatalf("只读文件不应被改写，实际 %q", got)
	}
	if !logsContain(h.logs(kardia.LoggerTypeWarn), "只读") {
		t.Fatalf("应告警只读，实际 %v", h.logs(kardia.LoggerTypeWarn))
	}

	// 无关的文件编辑保持内存中的覆盖
	h.writeFile(mustDumpYAML(t, []*loader.EntryOptions{cfgPlugin("a", 1), cfgPlugin("b", 2)}))
	h.settle()
	if got := mustConfigValue(t, h.configValue("a"), "value"); got != 2 {
		t.Fatalf("内存覆盖应保留 a=2，实际 %v", got)
	}
	if got := mustConfigValue(t, h.configValue("b"), "value"); got != 2 {
		t.Fatalf("文件编辑应生效 b=2，实际 %v", got)
	}
	if got := mustConfigValue(t, readConfig(t, h.readEntries()[0]), "value"); got != 1 {
		t.Fatalf("文件侧 a 应保持 1，实际 %v", got)
	}
}

func TestSyncRemovesNestedEntryThroughCompositeID(t *testing.T) {
	h := setupInclude(t, "tmp-sync-nested-remove.yml", []*loader.EntryOptions{cfgPlugin("a", 1), cfgPlugin("b", 1)}, nil)
	// 公开 id 是 `<include>:<local>`；组的 store 以本地 id 为键
	if err := h.loader.Remove(context.Background(), h.id+":a"); err != nil {
		t.Fatal(err)
	}
	h.settle()
	if h.configValue("a") != nil {
		t.Fatal("a 应被移除")
	}
	if got := mustConfigValue(t, h.configValue("b"), "value"); got != 1 {
		t.Fatalf("b 应保持装载，实际 %v", got)
	}
	if h.include().Entry("a") != nil {
		t.Fatal("include 的 store 不应再有 a")
	}
	var ids []string
	for _, e := range h.readEntries() {
		ids = append(ids, e.ID)
	}
	if len(ids) != 1 || ids[0] != "b" {
		t.Fatalf("文件应只剩 [b]，实际 %v", ids)
	}
}

func TestSyncRetriesWriteOnDispose(t *testing.T) {
	h := setupInclude(t, "tmp-sync-dispose-retry.yml", []*loader.EntryOptions{cfgPlugin("a", 1)}, nil)
	text := h.text()
	ops := &toggleOps{}
	h.include().SetFileOps(ops)
	ops.setWritable(false)

	if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}}); err != nil {
		t.Fatalf("更新 a 失败：%v", err)
	}
	h.settle()
	if got := h.text(); got != text {
		t.Fatalf("只读期间文件不应被改写，实际 %q", got)
	}

	// 文件恢复可写，但树上再无其它动作
	ops.setWritable(true)
	h.dispose()
	if got := mustConfigValue(t, readConfig(t, h.readEntries()[0]), "value"); got != 2 {
		t.Fatalf("销毁冲刷应把待写变更落盘（2），实际 %v", got)
	}
}

func TestSyncFlushesPendingChangesOnDispose(t *testing.T) {
	h := setupInclude(t, "tmp-sync-dispose.yml", []*loader.EntryOptions{cfgPlugin("a", 1)}, nil)
	if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}}); err != nil {
		t.Fatalf("更新 a 失败：%v", err)
	}
	h.dispose()
	if got := mustConfigValue(t, readConfig(t, h.readEntries()[0]), "value"); got != 2 {
		t.Fatalf("销毁冲刷应把待写变更落盘（2），实际 %v", got)
	}
}

// —— 辅助 ——

// readConfig 取条目 Config 的 map 形态（file 条目的 config 一律为映射）。
func readConfig(t *testing.T, e *loader.EntryOptions) map[string]any {
	t.Helper()
	if e.Config == nil {
		return nil
	}
	m, ok := e.Config.(map[string]any)
	if !ok {
		t.Fatalf("条目 config 应为映射，实际 %T", e.Config)
	}
	return m
}

func logsContain(logs []string, substr string) bool {
	for _, line := range logs {
		if strings.Contains(line, substr) {
			return true
		}
	}
	return false
}

func mustDumpYAML(t *testing.T, entries []*loader.EntryOptions) string {
	t.Helper()
	text, err := dumpYAMLEntries(entries)
	if err != nil {
		t.Fatal(err)
	}
	return text
}

var testBaseTime = time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC)
