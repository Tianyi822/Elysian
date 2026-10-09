package include

import (
	"context"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/kardia/loader"
)

func TestStopUnregistersInclude(t *testing.T) {
	h := setupInclude(t, "stop.yml", []*loader.EntryOptions{cfgPlugin("a", 1)}, nil)
	inc := h.include()
	if err := inc.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := IncludeOf(inc.EntryTree); got != nil {
		t.Fatal("停止后不得保留 include 反查引用")
	}
	if err := inc.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := inc.Refresh(context.Background()); err == nil {
		t.Fatal("停止后不能重新读取或启动插件")
	}
	if _, err := inc.Create(context.Background(), *cfgPlugin("resurrect", 9), nil, 0); err == nil {
		t.Fatal("停止后的树不得重新创建插件")
	}
	if err := inc.Root.Update(context.Background(), []*loader.EntryOptions{cfgPlugin("resurrect", 9)}); err == nil {
		t.Fatal("停止后的树不得调和新插件")
	}
}

func TestBootstrapFailureUnregistersInclude(t *testing.T) {
	registerIncludePlugins()
	ctx := kardia.NewContext()
	defer ctx.Fiber().Dispose(context.Background())
	fiber, err := ctx.Plugin(loader.Plugin, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fiber.Await(context.Background()); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "invalid.yml")
	if err := os.WriteFile(path, []byte("- {\n"), 0600); err != nil {
		t.Fatal(err)
	}
	includeByTreeMu.Lock()
	before := len(includeByTree)
	includeByTreeMu.Unlock()
	_, err = newInclude(ctx, Config{Path: path})
	if err == nil {
		t.Fatal("无效文件应使启动失败")
	}
	includeByTreeMu.Lock()
	after := len(includeByTree)
	includeByTreeMu.Unlock()
	if after != before {
		t.Fatalf("启动失败泄漏 include 反查记录：%d -> %d", before, after)
	}
}

func TestEmptyInitialCreatesEmptyFile(t *testing.T) {
	registerIncludePlugins()
	ctx := kardia.NewContext()
	defer ctx.Fiber().Dispose(context.Background())
	fiber, err := ctx.Plugin(loader.Plugin, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fiber.Await(context.Background()); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "empty.yml")
	dispose, err := newInclude(ctx, Config{Path: path, Initial: []*loader.EntryOptions{}})
	if err != nil {
		t.Fatal(err)
	}
	defer dispose(context.Background())
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(raw)) != "[]" {
		t.Fatalf("空 initial 应创建空数组，实际 %q", raw)
	}
	cfg, err := NormalizeConfig(map[string]any{"path": path, "initial": []any{}})
	if err != nil || cfg.Initial == nil {
		t.Fatalf("归一化必须保留显式空数组：%+v %v", cfg, err)
	}
}

func TestNestedIncludeResolvesRelativeDirectory(t *testing.T) {
	dir := t.TempDir()
	nested := filepath.Join(dir, "nested dir")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	inner := filepath.Join(nested, "inner.yml")
	if err := os.WriteFile(inner, []byte(mustDumpYAML(t, []*loader.EntryOptions{cfgPlugin("relative", 7)})), 0600); err != nil {
		t.Fatal(err)
	}
	filename, err := resolveFilename(nested, "inner.yml")
	if err != nil || filename != inner {
		t.Fatalf("相对路径必须基于目录自身：%q %v", filename, err)
	}
	uri := (&url.URL{Scheme: "file", Path: nested}).String()
	filename, err = resolveFilename(uri, "inner.yml")
	if err != nil || filename != inner {
		t.Fatalf("file URL 应解码空格并使用目录自身：%q %v", filename, err)
	}
	h := setupInclude(t, "outer.yml", []*loader.EntryOptions{{ID: "inc", Name: Plugin.Name, Config: map[string]any{"path": filepath.Join(nested, "inner.yml")}}}, nil)
	// 改为相对 outer 文件所在目录的路径，再重建 include，覆盖真正嵌套路径接线。
	rel, err := filepath.Rel(filepath.Dir(h.filename), inner)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.update("inc", loader.EntryOptions{Config: map[string]any{"path": rel}}); err != nil {
		t.Fatal(err)
	}
	h.settle()
	if got := mustConfigValue(t, h.configValue("relative"), "value"); got != 7 {
		t.Fatalf("嵌套 include 应正常读取，实际 %v", got)
	}
	entry, err := h.include().Resolve("inc")
	if err != nil {
		t.Fatal(err)
	}
	if got := IncludeOf(entry.Subtree()).Filename; got != inner {
		t.Fatalf("嵌套 include 路径错误：%q", got)
	}
}

func TestConfigFormatsRoundTripAndRejectSerializationFailure(t *testing.T) {
	yamlText := "- id: expr\n  name: ./config-plugin\n  disabled: true\n  unknown:\n    nested: preserved\n  config:\n    expression: !js process.env.SECRET\n"
	inc := &Include{Filename: "roundtrip.yml", fileType: yamlType}
	data, err := inc.parse([]byte(yamlText))
	if err != nil {
		t.Fatal(err)
	}
	dumped, err := inc.dump(data)
	if err != nil {
		t.Fatal(err)
	}
	again, err := inc.parse([]byte(dumped))
	if err != nil || !valueEqual(data, again) || !strings.Contains(dumped, "!js process.env.SECRET") {
		t.Fatalf("YAML !js 或未知字段未保真：%s；%v", dumped, err)
	}
	inc.fileType = jsonType
	if _, err := inc.dump(data); err == nil {
		t.Fatal("JSON 无法表示 !js 时必须报错")
	}
	jsonText := `[{"id":"a","name":"./config-plugin","inject":["service"],"isolate":{"foo":true},"intercept":{"foo":{"limit":2}},"unknown":{"nested":[1,true]},"config":{"tag":"a","value":2}}]`
	data, err = inc.parse([]byte(jsonText))
	if err != nil {
		t.Fatal(err)
	}
	dumped, err = inc.dump(data)
	if err != nil {
		t.Fatal(err)
	}
	again, err = inc.parse([]byte(dumped))
	if err != nil || !valueEqual(data, again) {
		t.Fatalf("JSON 字段未保真：%s；%v", dumped, err)
	}
	for _, kind := range []string{yamlType, jsonType} {
		inc.fileType = kind
		if _, err := inc.dump([]*loader.EntryOptions{{ID: "bad", Config: func() {}}}); err == nil {
			t.Fatalf("%s 不支持函数值时必须报错", kind)
		}
	}
}

func TestSerializationFailurePreservesOriginalFile(t *testing.T) {
	h := setupInclude(t, "serialize.yml", []*loader.EntryOptions{cfgPlugin("a", 1)}, nil)
	inc := h.include()
	original := h.text()
	inc.mu.Lock()
	MergeJournal(inc.journal, "a", &JournalRecord{Kind: KindUpsert, Changes: map[string]any{"config": func() {}}})
	inc.dirtyWrite = true
	inc.mu.Unlock()
	inc.drain()
	if err := inc.Flush(context.Background()); err == nil {
		t.Fatal("Flush 必须返回序列化错误")
	}
	if h.text() != original {
		t.Fatal("序列化失败不得清空或覆盖原文件")
	}
	inc.mu.Lock()
	pending := inc.journal.Len()
	// 错误已验证，删除测试专用无法序列化意向，让 harness 能正常清理。
	inc.journal = NewJournal()
	inc.drainErr = nil
	inc.mu.Unlock()
	if pending != 1 {
		t.Fatalf("序列化失败应保留账本，实际 %d", pending)
	}
}

func TestPlaceDetachReturnRootSlices(t *testing.T) {
	data := []*loader.EntryOptions{{ID: "a"}}
	var ok bool
	data, ok = Place(data, &loader.EntryOptions{ID: "b"}, nil, 1)
	if !ok || len(data) != 2 || data[1].ID != "b" {
		t.Fatalf("Place 未回传根切片：%v", data)
	}
	var removed *loader.EntryOptions
	data, removed = Detach(data, "a")
	if removed == nil || removed.ID != "a" || len(data) != 1 || data[0].ID != "b" {
		t.Fatalf("Detach 未回传根切片：%v %v", data, removed)
	}
}

type blockedWriteOps struct {
	osFileOps
	once    sync.Once
	entered chan struct{}
	release chan struct{}
}

func (o *blockedWriteOps) WriteFile(path string, data []byte) error {
	o.once.Do(func() { close(o.entered); <-o.release })
	return o.osFileOps.WriteFile(path, data)
}

func TestUpdatesDuringWriteKeepNewestRuntimeAndFile(t *testing.T) {
	h := setupInclude(t, "overlap.yml", []*loader.EntryOptions{cfgPlugin("a", 1)}, nil)
	ops := &blockedWriteOps{entered: make(chan struct{}), release: make(chan struct{})}
	inc := h.include()
	inc.SetFileOps(ops)
	if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ops.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("写任务未进入屏障")
	}
	for _, value := range []int{3, 4} {
		if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": value}}); err != nil {
			t.Fatal(err)
		}
	}
	close(ops.release)
	h.settle()
	if got := mustConfigValue(t, h.configValue("a"), "value"); got != 4 {
		t.Fatalf("运行时最新值被旧应用覆盖：%v", got)
	}
	if got := mustConfigValue(t, readConfig(t, h.readEntries()[0]), "value"); got != 4 {
		t.Fatalf("文件最新值丢失：%v", got)
	}
}

func TestCanceledStopStillFinishesAndUnregisters(t *testing.T) {
	h := setupInclude(t, "cancel-stop.yml", []*loader.EntryOptions{cfgPlugin("a", 1)}, nil)
	ops := &blockedWriteOps{entered: make(chan struct{}), release: make(chan struct{})}
	inc := h.include()
	inc.SetFileOps(ops)
	if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ops.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("写任务未进入屏障")
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := inc.Stop(canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("取消只应结束当前等待：%v", err)
	}
	if IncludeOf(inc.EntryTree) != nil {
		t.Fatal("停止开始后不得保留反查引用")
	}
	close(ops.release)
	if err := inc.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := mustConfigValue(t, readConfig(t, h.readEntries()[0]), "value"); got != 2 {
		t.Fatalf("重复等待应观察清理完成，文件值 %v", got)
	}
}

func TestJSExpressionIsOpaqueUntilEntryEnabled(t *testing.T) {
	h := setupInclude(t, "expression.yml", "- id: expression\n  name: ./config-plugin\n  disabled: true\n  config:\n    tag: expression\n    value: !js process.env.VALUE\n", nil)
	if got := h.configValue("expression"); got != nil {
		t.Fatalf("禁用条目不得执行：%v", got)
	}
	err := h.update("expression", loader.EntryOptions{Disabled: bptr(false)})
	if err == nil || !strings.Contains(err.Error(), "!js") {
		t.Fatalf("启用表达式配置必须明确报错：%v", err)
	}
	if got := h.configValue("expression"); got != nil {
		t.Fatalf("表达式不能作为正常值交给插件：%v", got)
	}
	if err := h.update("expression", loader.EntryOptions{Disabled: bptr(true)}); err != nil {
		t.Fatal(err)
	}
	h.settle()
	if !strings.Contains(h.text(), "!js process.env.VALUE") {
		t.Fatal("失败的执行尝试不得破坏表达式保真")
	}
}

func TestConfigSnapshotsClonePrivatePatchFields(t *testing.T) {
	patch := PatchOptions{ID: sptr("a")}
	patch.SetOverride("config", map[string]any{"nested": []any{"original"}})
	original := Config{Path: "config.yml", Patches: []PatchOptions{patch}}
	cloned := loader.CloneOptions(&loader.EntryOptions{Config: original}).Config.(Config)
	value, _ := cloned.Patches[0].GetOverride("config")
	value.(map[string]any)["nested"].([]any)[0] = "changed"
	kept, _ := original.Patches[0].GetOverride("config")
	if kept.(map[string]any)["nested"].([]any)[0] != "original" {
		t.Fatal("配置快照不得共享补丁的私有覆盖表")
	}
}

func TestMalformedConfigurationReturnsErrorWithoutDroppingFields(t *testing.T) {
	raw := map[string]any{"path": "config.yml", "future": map[string]any{"flag": true}}
	cfg, err := NormalizeConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got := configToNative(cfg)["future"]; !valueEqual(got, raw["future"]) {
		t.Fatalf("include配置未知字段必须保真：%v", got)
	}

	inc := &Include{Filename: "invalid.yml", fileType: yamlType}
	for _, text := range []string{
		"- name: ./config-plugin\n  inject: [foo, 1]\n",
		"- name: ./config-plugin\n  disabled: maybe\n",
		"- name: ./config-plugin\n  isolate: true\n",
		"- name: ./config-plugin\n  config: &loop [*loop]\n",
		"- name: ./config-plugin\n  config: {value: 1, value: 2}\n",
		"- name: ./config-plugin\n  config: !unknown value\n",
	} {
		if _, err := inc.parse([]byte(text)); err == nil {
			t.Fatalf("无效配置不应静默丢字段：%s", text)
		}
	}
	for _, value := range []any{
		map[string]any{"path": 12},
		map[string]any{"path": "a.yml", "initial": []any{"invalid"}},
		map[string]any{"path": "a.yml", "patches": true},
		map[string]any{"path": "a.yml", "patches": []any{false}},
		map[string]any{"path": "a.yml", "patches": []any{map[string]any{"insert": []any{12}}}},
		map[string]any{"path": "a.yml", "enableLogs": "yes"},
	} {
		if _, err := NormalizeConfig(value); err == nil {
			t.Fatalf("无效 include 配置应报错：%v", value)
		}
	}
}

func TestExpressionInMetadataRemainsOpaque(t *testing.T) {
	inc := &Include{Filename: "metadata.yml", fileType: yamlType}
	data, err := inc.parse([]byte("- id: expr\n  name: ./config-plugin\n  disabled: true\n  inject: !js process.env.INJECT\n  unknown: {value: 12}\n"))
	if err != nil {
		t.Fatal(err)
	}
	dumped, err := inc.dump(data)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(dumped, "inject: !js process.env.INJECT") {
		t.Fatalf("元数据表达式必须保真，实际 %s", dumped)
	}
	reparsed, err := inc.parse([]byte(dumped))
	if err != nil || !valueEqual(data, reparsed) {
		t.Fatalf("元数据表达式或未知字段未保真：%v", err)
	}
}

func TestConfigUpdateListenerCanFlush(t *testing.T) {
	h := setupInclude(t, "callback-flush.yml", []*loader.EntryOptions{cfgPlugin("a", 1)}, nil)
	inc := h.include()
	completed := make(chan error, 1)
	off, err := h.ctx.On(kardia.StringEvent("loader/config-update"), func(*kardia.EventCtx) (any, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		err := inc.Flush(ctx)
		completed <- err
		return nil, err
	})
	if err != nil {
		t.Fatal(err)
	}
	defer off()
	if err := h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("配置回调 Flush 死锁")
	}
}

func TestEnableLogsDistinguishesUnsetAndFalse(t *testing.T) {
	h := setupInclude(t, "logs-outer.yml", []*loader.EntryOptions{}, nil)
	h.include().SetEnableLogs(true)
	nested := filepath.Join(filepath.Dir(h.filename), "nested.yml")
	if err := os.WriteFile(nested, []byte("[]\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name     string
		explicit *bool
		want     bool
	}{
		{name: "inherit", want: true},
		{name: "disabled", explicit: bptr(false), want: false},
		{name: "enabled", explicit: bptr(true), want: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := Config{Path: nested, EnableLogs: tc.explicit}
			id, err := h.include().Create(context.Background(), loader.EntryOptions{Name: Plugin.Name, Config: cfg}, nil, -1)
			if err != nil {
				t.Fatal(err)
			}
			e, err := h.loader.Resolve(id)
			if err != nil {
				t.Fatal(err)
			}
			if got := IncludeOf(e.Subtree()).EnableLogs(); got != tc.want {
				t.Fatalf("日志继承结果 %v，期望 %v", got, tc.want)
			}
		})
	}
	cfg, err := NormalizeConfig(map[string]any{"path": "a.yml", "enableLogs": false})
	if err != nil || cfg.EnableLogs == nil || *cfg.EnableLogs {
		t.Fatalf("显式false必须保留：%+v %v", cfg, err)
	}
	if got, exists := configToNative(cfg)["enableLogs"]; !exists || got != false {
		t.Fatalf("显式false必须写回：%v %v", got, exists)
	}
}

func TestStopFlushesAcceptedCommitBeforeClosing(t *testing.T) {
	h := setupInclude(t, "queued-stop.yml", []*loader.EntryOptions{cfgPlugin("a", 1)}, nil)
	inc := h.include()
	entered, release := make(chan struct{}), make(chan struct{})
	inc.EntryTree.SetCommit(func(change loader.EntryChange) { close(entered); <-release; inc.commit(change) })
	updateDone := make(chan error, 1)
	go func() {
		updateDone <- h.update("a", loader.EntryOptions{Config: map[string]any{"tag": "a", "value": 2}})
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("更新未进入提交屏障")
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := inc.Stop(canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("停止调用等待应取消：%v", err)
	}
	close(release)
	if err := inc.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-updateDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("已接受的更新未收敛")
	}
	if got := mustConfigValue(t, readConfig(t, h.readEntries()[0]), "value"); got != 2 {
		t.Fatalf("停止遗漏已接受的提交：%v", got)
	}
}

type blockedReadOps struct {
	osFileOps
	once    sync.Once
	entered chan struct{}
	release chan struct{}
}

func (o *blockedReadOps) ReadFile(path string) ([]byte, error) {
	o.once.Do(func() { close(o.entered); <-o.release })
	return o.osFileOps.ReadFile(path)
}

func TestParentStopPersistsPendingChildPatch(t *testing.T) {
	inner := filepath.Join(t.TempDir(), "inner-patch.yml")
	initial := mustDumpYAML(t, []*loader.EntryOptions{cfgPlugin("a", 1)})
	if err := os.WriteFile(inner, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	h := setupInclude(t, "parent-stop.yml", []*loader.EntryOptions{{ID: "inc", Name: Plugin.Name, Config: map[string]any{
		"path": inner, "patches": []any{map[string]any{"id": "a", "disabled": true}},
	}}}, nil)
	parent := h.include()
	child := IncludeOf(parent.Entry("inc").Subtree())
	ops := &blockedReadOps{entered: make(chan struct{}), release: make(chan struct{})}
	child.SetFileOps(ops)
	if err := h.update("inc:a", loader.EntryOptions{Disabled: bptr(false)}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ops.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("子补丁写回未进入屏障")
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := parent.Stop(canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("父停止等待应取消：%v", err)
	}
	// 等 Seal 完成，明确构造父准入关闭后子补丁才被释放的交错。
	if err := parent.EntryTree.Seal(context.Background()); err != nil {
		t.Fatal(err)
	}
	close(ops.release)
	if err := parent.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	cfg := readConfig(t, h.readEntries()[0])
	patches, ok := cfg["patches"].([]any)
	if !ok || len(patches) != 1 {
		t.Fatalf("父配置补丁丢失：%v", cfg)
	}
	patch := patches[0].(map[string]any)
	if patch["disabled"] != false {
		t.Fatalf("停止必须先落子补丁到父文件：%v", patch)
	}
	content, err := os.ReadFile(inner)
	if err != nil || string(content) != initial {
		t.Fatalf("补丁归属父文件，子文件应保留：%q %v", content, err)
	}
	if IncludeOf(child.EntryTree) != nil {
		t.Fatal("子include停止后仍可反查")
	}
}
