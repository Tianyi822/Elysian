// reload_test.go 对应 include/tests/reload.spec.ts 的 4 个用例。TS 的
// waitFor 实时轮询在 Go 侧改为确定性等待：refresh/flush + loader.await +
// 任务收敛（方案 2.0 的测试确定性契约）。
package include

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/kardia/loader"
)

const (
	innerYAML      = "- id: inner\n  name: ./test-plugin\n"
	innerExtraYAML = "- id: inner\n  name: ./test-plugin\n- id: extra\n  name: ./extra-plugin\n"
	notAnArrayYAML = "inner: ./test-plugin\n"
	unparsableYAML = "- {\n"
)

// waitForPlugins 以树与任务收敛替代 TS 的 waitFor 轮询。
func waitForPlugins(t *testing.T, h *includeHarness) {
	t.Helper()
	if err := h.include().Refresh(context.Background()); err != nil {
		t.Fatalf("refresh 失败：%v", err)
	}
	if err := h.loader.Await(context.Background()); err != nil {
		t.Fatalf("等待树失败：%v", err)
	}
	if err := h.ctx.Tasks().Wait(context.Background()); err != nil {
		t.Fatalf("等待任务失败：%v", err)
	}
}

func TestReloadReappliesPatchesOnEveryReload(t *testing.T) {
	h := setupInclude(t, "tmp-reload-patches.yml", innerYAML, func(c *Config) {
		patch := PatchOptions{ID: sptr("inner")}
		patch.SetOverride("disabled", true)
		c.Patches = []PatchOptions{patch}
	})
	if v := h.bailValue("test/get-value"); v != nil {
		t.Fatalf("被补丁禁用的条目不应装载，实际 %v", v)
	}

	h.writeFile(innerExtraYAML)
	if err := h.include().Refresh(context.Background()); err != nil {
		t.Fatalf("refresh 失败：%v", err)
	}
	waitForPlugins(t, h)

	// 新条目装载，且覆盖对新解析同样生效
	if v := h.bailValue("test/get-extra"); v != "extra" {
		t.Fatalf("新增条目应装载，实际 %v", v)
	}
	if v := h.bailValue("test/get-value"); v != nil {
		t.Fatalf("补丁应对新解析继续生效，实际 %v", v)
	}
}

func TestReloadRevertsEntryWhenPatchRemoved(t *testing.T) {
	h := setupInclude(t, "tmp-reload-revert.yml", innerYAML, func(c *Config) {
		patch := PatchOptions{ID: sptr("inner")}
		patch.SetOverride("disabled", true)
		c.Patches = []PatchOptions{patch}
	})
	if v := h.bailValue("test/get-value"); v != nil {
		t.Fatalf("被补丁禁用的条目不应装载，实际 %v", v)
	}

	// 补丁作用于缓存解析的克隆，去掉补丁即回退条目
	if err := h.loader.Update(context.Background(), h.id, loader.PatchOptions(loader.EntryOptions{
		Config: map[string]any{"path": h.filename},
	}), nil, nil); err != nil {
		t.Fatalf("更新 include 配置失败：%v", err)
	}
	waitForPlugins(t, h)
	if v := h.bailValue("test/get-value"); v != "default" {
		t.Fatalf("移除补丁后条目应回退装载，实际 %v", v)
	}
}

func TestReloadKeepsTreeReloadableAfterInvalidFile(t *testing.T) {
	h := setupInclude(t, "tmp-reload-invalid.yml", innerYAML, nil)
	if v := h.bailValue("test/get-value"); v != "default" {
		t.Fatalf("初始条目应装载，实际 %v", v)
	}

	h.writeFile(notAnArrayYAML)
	// 坏文件通过返回值及日志同时报告，既有运行树保留。
	if err := h.include().Refresh(context.Background()); err == nil {
		t.Fatal("refresh 应报告配置校验失败")
	}
	if !logsContain(h.logs(kardia.LoggerTypeWarn), "无法校验配置文件") {
		t.Fatalf("应告警校验失败，实际 %v", h.logs(kardia.LoggerTypeWarn))
	}
	if v := h.bailValue("test/get-value"); v != "default" {
		t.Fatalf("坏文件不应影响既有树，实际 %v", v)
	}

	// 缓存仍持最后一次有效文件，下一个好文件作为变更读入并与完好的树调和
	h.writeFile(innerExtraYAML)
	if err := h.include().Refresh(context.Background()); err != nil {
		t.Fatalf("refresh 失败：%v", err)
	}
	waitForPlugins(t, h)
	if v := h.bailValue("test/get-extra"); v != "extra" {
		t.Fatalf("恢复后新条目应装载，实际 %v", v)
	}
	if v := h.bailValue("test/get-value"); v != "default" {
		t.Fatalf("恢复后既有条目应保持装载，实际 %v", v)
	}
}

func TestReloadNeverOverwritesUnparsableFileWithInitial(t *testing.T) {
	registerIncludePlugins()
	ctx := kardia.NewContext()
	filename := filepath.Join(t.TempDir(), "invalid.yml")
	if err := os.WriteFile(filename, []byte(unparsableYAML), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := newInclude(ctx, Config{Path: filename, Initial: []*loader.EntryOptions{{ID: "extra", Name: "./extra-plugin"}}})
	if err == nil {
		t.Fatal("不可解析的文件应返回启动错误")
	}
	content, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != unparsableYAML {
		t.Fatalf("不可解析的文件应原样保留，实际 %q", content)
	}
	value, err := ctx.Bail(kardia.StringEvent("test/get-extra"))
	if err != nil || value != nil {
		t.Fatalf("initial 不得生效：%v %v", value, err)
	}
}
