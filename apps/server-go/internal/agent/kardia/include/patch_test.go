// patch_test.go 对应 include/tests/patch.spec.ts 的 11 个用例（端到端：
// loader 与 include.go 交付后联调；base.yml 按 fixture 原样内联，三个 TS
// fixture 插件改为编译期注册），另含 ApplyPatches/PatchIndex/RouteJournal
// 的机制级用例（场景取自 sync.spec 的两个 routes 用例反推）。
package include

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/kardia/loader"
)

// baseYAML 对应 include/tests/fixtures/base.yml，内容原样内联。
const baseYAML = `- id: timer
  name: '@cordisjs/plugin-timer'
- id: group
  name: '@cordisjs/plugin-group'
  group: true
  config:
    - id: inner
      name: ./test-plugin
`

var patchPluginsOnce sync.Once

// registerPatchPlugins 把 fixture 插件与 include 本体注册进编译期注册表
// （替代 TS 侧的 Node 模块解析）。timer 在 patch.spec 中只被装载不被使用，
// 注册为无操作插件。
func registerPatchPlugins() {
	patchPluginsOnce.Do(func() {
		loader.RegisterFunc("@cordisjs/plugin-timer", func(ctx *kardia.Context, config any) (kardia.Disposable, error) {
			return nil, nil
		})
		loader.Register("@cordisjs/plugin-group", loader.Group)
		loader.Register("@cordisjs/plugin-include", Plugin)
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
	})
}

// listExporter 收集全部日志消息，供告警文案断言。
type listExporter struct {
	kardia.ExporterBase
	mu       sync.Mutex
	messages []string
}

func (e *listExporter) Export(m *kardia.Message) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.messages = append(e.messages, fmt.Sprint(m.Args...))
}

func (e *listExporter) has(substr string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, msg := range e.messages {
		if strings.Contains(msg, substr) {
			return true
		}
	}
	return false
}

// bootInclude 对应 patch.spec 每个用例的前置：起 loader、挂 include、等待
// 树就绪。before 在创建 include 之前调用（用于挂日志导出器等）。
func bootInclude(t *testing.T, patches []PatchOptions, before func(ctx *kardia.Context)) (*kardia.Context, *kardia.Fiber, func(string) (any, error)) {
	t.Helper()
	registerPatchPlugins()
	dir := t.TempDir()
	filename := filepath.Join(dir, "base.yml")
	if err := os.WriteFile(filename, []byte(baseYAML), 0o644); err != nil {
		t.Fatalf("写入 base.yml 失败：%v", err)
	}
	ctx := kardia.NewContext()
	if before != nil {
		before(ctx)
	}
	fiber, err := ctx.Plugin(loader.Plugin, nil)
	if err != nil {
		t.Fatalf("装载 loader 失败：%v", err)
	}
	// fiber 加载异步，Get 前先等惯性排空，否则 loose 路径静默返回 nil。
	if _, err := fiber.Await(context.Background()); err != nil {
		t.Fatalf("等待 loader 插件激活失败：%v", err)
	}
	svc, err := ctx.Get("loader")
	if err != nil {
		t.Fatalf("解析 loader 服务失败：%v", err)
	}
	l, ok := svc.(*loader.Loader)
	if !ok {
		t.Fatalf("loader 服务类型异常：%T", svc)
	}
	if _, err := l.Create(context.Background(), loader.EntryOptions{
		Name:   Plugin.Name,
		Config: Config{Path: filename, Patches: patches},
	}, nil, 0); err != nil {
		t.Fatalf("创建 include 失败：%v", err)
	}
	if err := l.Await(context.Background()); err != nil {
		t.Fatalf("等待树就绪失败：%v", err)
	}
	bail := func(name string) (any, error) {
		return ctx.Bail(kardia.StringEvent(name))
	}
	return ctx, fiber, bail
}

func mustBail(t *testing.T, bail func(string) (any, error), name string) any {
	t.Helper()
	v, err := bail(name)
	if err != nil {
		t.Fatalf("bail %s 出错：%v", name, err)
	}
	return v
}

// —— patch.spec.ts 的 11 个用例 ——

func TestPatchLoadWithoutPatches(t *testing.T) {
	_, fiber, bail := bootInclude(t, nil, nil)
	defer func() { _ = fiber.Dispose(context.Background()) }()
	if v := mustBail(t, bail, "test/get-value"); v != "default" {
		t.Fatalf("期望 default，实际 %v", v)
	}
}

func TestPatchDisableEntry(t *testing.T) {
	patch := PatchOptions{ID: sptr("inner")}
	patch.SetOverride("disabled", true)
	_, fiber, bail := bootInclude(t, []PatchOptions{patch}, nil)
	defer func() { _ = fiber.Dispose(context.Background()) }()
	if v := mustBail(t, bail, "test/get-value"); v != nil {
		t.Fatalf("被补丁禁用的条目不应装载，实际 %v", v)
	}
}

func TestPatchOverrideConfig(t *testing.T) {
	patch := PatchOptions{ID: sptr("inner")}
	patch.SetOverride("config", map[string]any{"custom": true})
	_, fiber, bail := bootInclude(t, []PatchOptions{patch}, nil)
	defer func() { _ = fiber.Dispose(context.Background()) }()
	// 配置覆盖不应破坏装载
	if v := mustBail(t, bail, "test/get-value"); v != "default" {
		t.Fatalf("期望 default，实际 %v", v)
	}
}

func TestPatchWarnOnNameMismatchAndSkip(t *testing.T) {
	patch := PatchOptions{ID: sptr("inner"), Name: sptr("wrong-name")}
	patch.SetOverride("disabled", true)
	exp := &listExporter{}
	_, fiber, bail := bootInclude(t, []PatchOptions{patch}, func(ctx *kardia.Context) {
		ctx.LoggerService().Exporter(ctx, exp)
	})
	defer func() { _ = fiber.Dispose(context.Background()) }()
	// 名称不匹配的补丁被跳过，插件仍然活跃
	if v := mustBail(t, bail, "test/get-value"); v != "default" {
		t.Fatalf("期望 default，实际 %v", v)
	}
	if !exp.has("名称不匹配") {
		t.Fatalf("应产生名称不匹配的告警，实际 %v", exp.messages)
	}
}

func TestPatchWarnOnNonExistentID(t *testing.T) {
	patch := PatchOptions{ID: sptr("nonexistent")}
	patch.SetOverride("disabled", true)
	exp := &listExporter{}
	_, fiber, bail := bootInclude(t, []PatchOptions{patch}, func(ctx *kardia.Context) {
		ctx.LoggerService().Exporter(ctx, exp)
	})
	defer func() { _ = fiber.Dispose(context.Background()) }()
	if v := mustBail(t, bail, "test/get-value"); v != "default" {
		t.Fatalf("期望 default，实际 %v", v)
	}
	if !exp.has("找不到条目") {
		t.Fatalf("应产生找不到条目的告警，实际 %v", exp.messages)
	}
}

func TestPatchInsertIntoRoot(t *testing.T) {
	patch := PatchOptions{Insert: []*loader.EntryOptions{{Name: "./extra-plugin"}}}
	_, fiber, bail := bootInclude(t, []PatchOptions{patch}, nil)
	defer func() { _ = fiber.Dispose(context.Background()) }()
	if v := mustBail(t, bail, "test/get-extra"); v != "extra" {
		t.Fatalf("期望 extra，实际 %v", v)
	}
	if v := mustBail(t, bail, "test/get-value"); v != "default" {
		t.Fatalf("原有插件应不受影响，实际 %v", v)
	}
}

func TestPatchInsertIntoGroup(t *testing.T) {
	patch := PatchOptions{
		ID:     sptr("group"),
		Insert: []*loader.EntryOptions{{Name: "./extra-plugin"}},
	}
	_, fiber, bail := bootInclude(t, []PatchOptions{patch}, nil)
	defer func() { _ = fiber.Dispose(context.Background()) }()
	if v := mustBail(t, bail, "test/get-extra"); v != "extra" {
		t.Fatalf("期望 extra，实际 %v", v)
	}
}

func TestPatchWarnInsertIntoNonGroup(t *testing.T) {
	patch := PatchOptions{
		ID:     sptr("timer"),
		Insert: []*loader.EntryOptions{{Name: "./extra-plugin"}},
	}
	_, fiber, bail := bootInclude(t, []PatchOptions{patch}, nil)
	defer func() { _ = fiber.Dispose(context.Background()) }()
	if v := mustBail(t, bail, "test/get-value"); v != "default" {
		t.Fatalf("期望 default，实际 %v", v)
	}
	// timer 不是组：extra 不应被装载
	if v := mustBail(t, bail, "test/get-extra"); v != nil {
		t.Fatalf("插入非组条目应被拒绝，实际 %v", v)
	}
}

func TestPatchApplyMultiple(t *testing.T) {
	disable := PatchOptions{ID: sptr("inner")}
	disable.SetOverride("disabled", true)
	insert := PatchOptions{Insert: []*loader.EntryOptions{{Name: "./extra-plugin"}}}
	_, fiber, bail := bootInclude(t, []PatchOptions{disable, insert}, nil)
	defer func() { _ = fiber.Dispose(context.Background()) }()
	if v := mustBail(t, bail, "test/get-value"); v != nil {
		t.Fatalf("inner 应被禁用，实际 %v", v)
	}
	if v := mustBail(t, bail, "test/get-extra"); v != "extra" {
		t.Fatalf("extra 应被装载，实际 %v", v)
	}
}

func TestPatchLaterPatchAddressesInsertedRow(t *testing.T) {
	insert := PatchOptions{Insert: []*loader.EntryOptions{{ID: "added", Name: "./extra-plugin"}}}
	disable := PatchOptions{ID: sptr("added")}
	disable.SetOverride("disabled", true)
	_, fiber, bail := bootInclude(t, []PatchOptions{insert, disable}, nil)
	defer func() { _ = fiber.Dispose(context.Background()) }()
	if v := mustBail(t, bail, "test/get-value"); v != "default" {
		t.Fatalf("期望 default，实际 %v", v)
	}
	// 插入行随落随索引：第二个补丁应能找到 added
	if v := mustBail(t, bail, "test/get-extra"); v != nil {
		t.Fatalf("added 应被后续补丁禁用，实际 %v", v)
	}
}

func TestPatchNameConsistencyMatch(t *testing.T) {
	patch := PatchOptions{ID: sptr("inner"), Name: sptr("./test-plugin")}
	patch.SetOverride("disabled", true)
	_, fiber, bail := bootInclude(t, []PatchOptions{patch}, nil)
	defer func() { _ = fiber.Dispose(context.Background()) }()
	// 名称匹配：补丁生效，inner 被禁用
	if v := mustBail(t, bail, "test/get-value"); v != nil {
		t.Fatalf("名称匹配时补丁应生效，实际 %v", v)
	}
}

// —— 机制级用例：ApplyPatches / PatchIndex / RouteJournal ——

func patchData() []*loader.EntryOptions {
	return []*loader.EntryOptions{
		entry("timer", "@cordisjs/plugin-timer"),
		groupEntry("group", []*loader.EntryOptions{entry("inner", "./test-plugin")}),
	}
}

func TestApplyPatchesOverrides(t *testing.T) {
	data := patchData()
	inner := Flatten(data, nil)["inner"].Options

	patch := PatchOptions{ID: sptr("inner")}
	patch.SetOverride("disabled", true)
	out := ApplyPatches(data, []PatchOptions{patch}, nil)

	// 返回深拷贝：源数据不被触碰
	if inner.Disabled != nil {
		t.Fatal("源数据不应被补丁修改")
	}
	got := Flatten(out, nil)["inner"].Options
	if got.Disabled == nil || !*got.Disabled {
		t.Fatal("补丁键应写进克隆条目")
	}

	// config 覆盖同样落进克隆
	patch2 := PatchOptions{ID: sptr("inner")}
	patch2.SetOverride("config", map[string]any{"custom": true})
	out2 := ApplyPatches(data, []PatchOptions{patch2}, nil)
	if !valueEqual(Flatten(out2, nil)["inner"].Options.Config, map[string]any{"custom": true}) {
		t.Fatalf("config 覆盖应生效，实际 %v", Flatten(out2, nil)["inner"].Options.Config)
	}
}

func TestApplyPatchesInserts(t *testing.T) {
	data := patchData()

	// 根插入
	insertRoot := PatchOptions{Insert: []*loader.EntryOptions{{Name: "./extra-plugin"}}}
	out := ApplyPatches(data, []PatchOptions{insertRoot}, nil)
	if len(out) != 3 || out[2].Name != "./extra-plugin" {
		t.Fatalf("根插入应追加到末尾，实际 %v 个条目", len(out))
	}

	// 组插入
	insertGroup := PatchOptions{
		ID:     sptr("group"),
		Insert: []*loader.EntryOptions{{Name: "./extra-plugin"}},
	}
	out2 := ApplyPatches(data, []PatchOptions{insertGroup}, nil)
	list, ok := listOf(Flatten(out2, nil)["group"].Options)
	if !ok || len(list) != 2 || list[1].Name != "./extra-plugin" {
		t.Fatalf("组插入应追加进成员列表，实际 %v", list)
	}

	// 插入进不存在的条目 / 非组条目：告警并跳过
	var warns []string
	capture := func(format string, args ...any) { warns = append(warns, format) }
	bad1 := PatchOptions{ID: sptr("nope"), Insert: []*loader.EntryOptions{{Name: "./x"}}}
	bad2 := PatchOptions{ID: sptr("timer"), Insert: []*loader.EntryOptions{{Name: "./x"}}}
	ApplyPatches(data, []PatchOptions{bad1, bad2}, capture)
	if len(warns) != 2 || !strings.Contains(warns[0], "找不到条目") || !strings.Contains(warns[1], "不是组") {
		t.Fatalf("插入目标异常应各告警一次，实际 %v", warns)
	}

	// 无 id 的非 insert 补丁：告警跳过
	warns = nil
	noID := PatchOptions{}
	noID.SetOverride("disabled", true)
	ApplyPatches(data, []PatchOptions{noID}, capture)
	if len(warns) != 1 || !strings.Contains(warns[0], "必须提供 id") {
		t.Fatalf("缺 id 的补丁应告警，实际 %v", warns)
	}
}

func TestPatchIndexOwners(t *testing.T) {
	disable := PatchOptions{ID: sptr("inner")}
	disable.SetOverride("disabled", true)
	nested := PatchOptions{Insert: []*loader.EntryOptions{
		groupEntry("ig", []*loader.EntryOptions{entry("added", "./x")}),
	}}
	pi := NewPatchIndex([]PatchOptions{disable, nested})

	if !pi.FileOwned("inner", nil) {
		t.Fatal("文件条目整体归文件")
	}
	if pi.FileOwned("inner", sptr("disabled")) {
		t.Fatal("被补丁覆盖的键不归文件")
	}
	if owner := pi.Key("inner", "name"); owner.Kind != OwnerFile {
		t.Fatalf("未被覆盖的键应归文件，实际 %s", owner.Kind)
	}
	if owner := pi.Key("inner", "disabled"); owner.Kind != OwnerPatch || owner.Index != 0 {
		t.Fatalf("被覆盖的键应归补丁 0，实际 %+v", owner)
	}
	owner := pi.Entry(sptr("added"))
	if owner.Kind != OwnerInsert || owner.Index != 1 || parentName(owner.Parent) != "ig" {
		t.Fatalf("嵌套 insert 条目应记补丁 1 与父组 ig，实际 %+v", owner)
	}
	if pi.FileOwned("added", nil) || pi.FileOwned("added", sptr("name")) {
		t.Fatal("插入条目不归文件")
	}
	if pi.Entry(nil).Kind != OwnerFile {
		t.Fatal("根应归文件")
	}
}

// 场景取自 sync「routes changes to patch-owned keys into the parent config」：
// 补丁持有的键路由回补丁，文件数据不动。
func TestRouteJournalPatchOwnedKey(t *testing.T) {
	data := []*loader.EntryOptions{{ID: "a", Name: "./p", Config: map[string]any{"v": 1}}}
	patches := []PatchOptions{{ID: sptr("a")}}
	patches[0].SetOverride("disabled", true)

	j := NewJournal()
	MergeJournal(j, "a", &JournalRecord{
		Kind:    KindUpsert,
		Changes: map[string]any{"disabled": bptr(false)},
	})
	var patched bool
	data, patched = RouteJournal(j, data, patches, nil)
	if !patched {
		t.Fatal("补丁被改动应返回 true")
	}
	if data[0].Disabled != nil {
		t.Fatal("补丁持有的键不应落进文件数据")
	}
	if v, ok := patches[0].GetOverride("disabled"); !ok || !valueEqual(v, bptr(false)) {
		t.Fatalf("变更应路由回补丁，实际 (%v, %v)", v, ok)
	}
	// 路由不消费账本：记录由 _write 的批量换出管理
	if j.Len() != 1 {
		t.Fatalf("路由不应改动账本，实际剩 %d 条", j.Len())
	}
}

// 场景取自 sync「routes changes to inserted entries into their patch」：
// 插入条目的变更与移除都路由回补丁的 insert 列表。
func TestRouteJournalInsertedEntry(t *testing.T) {
	data := []*loader.EntryOptions{{ID: "a", Name: "./p", Config: map[string]any{"v": 1}}}
	inserted := &loader.EntryOptions{ID: "x", Name: "./p", Config: map[string]any{"v": 1}}
	patches := []PatchOptions{{Insert: []*loader.EntryOptions{inserted}}}

	j := NewJournal()
	MergeJournal(j, "x", &JournalRecord{
		Kind:    KindUpsert,
		Changes: map[string]any{"config": map[string]any{"v": 2}},
	})
	data, patched := RouteJournal(j, data, patches, nil)
	if !patched {
		t.Fatal("补丁被改动应返回 true")
	}
	if !valueEqual(inserted.Config, map[string]any{"v": 2}) {
		t.Fatalf("插入条目的变更应落在 insert 上，实际 %v", inserted.Config)
	}
	if !valueEqual(data[0].Config, map[string]any{"v": 1}) {
		t.Fatal("文件数据不应被触碰")
	}

	// 移除插入条目：从 insert 列表摘除
	j = NewJournal()
	MergeJournal(j, "x", &JournalRecord{Kind: KindRemove})
	data, patched = RouteJournal(j, data, patches, nil)
	if !patched {
		t.Fatal("补丁被改动应返回 true")
	}
	if len(patches[0].Insert) != 0 {
		t.Fatalf("插入条目应被移除，实际 %v", patches[0].Insert)
	}
}

// 根级结构变更经 dataSlot 回传：这是 RouteJournal 契约签名无法表达、
// 由 RouteJournal 承载的部分。
func TestRouteJournalRootSplices(t *testing.T) {
	a := &loader.EntryOptions{ID: "a", Name: "./p"}
	data := []*loader.EntryOptions{a}

	// 运行时新建根级条目
	j := NewJournal()
	MergeJournal(j, "b", &JournalRecord{
		Kind:     KindUpsert,
		Created:  true,
		Parent:   rooted(nil),
		Position: 1,
		Changes:  map[string]any{"name": "./q"},
	})
	data, patched := RouteJournal(j, data, nil, nil)
	if patched {
		t.Fatal("未触及补丁应返回 false")
	}
	if len(data) != 2 || data[1].ID != "b" || data[1].Name != "./q" {
		t.Fatalf("新建条目应经 dataSlot 落进根列表，实际 %v", data)
	}

	// 运行时移除根级条目
	j = NewJournal()
	MergeJournal(j, "a", &JournalRecord{Kind: KindRemove})
	data, _ = RouteJournal(j, data, nil, nil)
	if len(data) != 1 || data[0].ID != "b" {
		t.Fatalf("根级移除应经 dataSlot 生效，实际 %v", data)
	}
}
