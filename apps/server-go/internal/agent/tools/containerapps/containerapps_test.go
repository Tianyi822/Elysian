// 容器应用工作区能力的测试：登记表与文件都落在 t.TempDir()，测试结束由 testing
// 统一删除。刻意不构造 containerapps.BuildManager——它带一个不可停的小时级清理
// 定时器，本层的所有权契约要求它由宿主注入（见包注释与 ADR-0023）。
package containerapps

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domainapps "elysian/server/internal/containerapps"
)

// baseTime 是登记时间的固定基准，断言不依赖真实时钟。
var baseTime = time.Date(2026, 10, 9, 10, 0, 0, 0, time.UTC)

// workspace 建一个带 compose 与 .env 的真实工作区，返回登记表与挂载根。
func workspace(t *testing.T) (*domainapps.Registry, string) {
	t.Helper()
	mountRoot := t.TempDir()
	registry := &domainapps.Registry{
		MountRoot:    mountRoot,
		RegistryPath: filepath.Join(t.TempDir(), "container-apps.json"),
	}
	record, err := registry.Create("demo-app", "演示应用", baseTime)
	if err != nil {
		t.Fatalf("建工作区失败：%v", err)
	}
	compose := "services:\n  demo:\n    image: nginx:1.27\n    env_file:\n      - ./.env\n    volumes:\n      - ./data:/data\n"
	if err := os.WriteFile(filepath.Join(record.Directory, "compose.yaml"), []byte(compose), 0o600); err != nil {
		t.Fatalf("写 compose 失败：%v", err)
	}
	if err := os.WriteFile(filepath.Join(record.Directory, ".env"), []byte("DEMO=1\n"), 0o600); err != nil {
		t.Fatalf("写 .env 失败：%v", err)
	}
	if err := os.MkdirAll(filepath.Join(record.Directory, "data"), 0o700); err != nil {
		t.Fatalf("建数据目录失败：%v", err)
	}
	return registry, mountRoot
}

func install(t *testing.T, deps Deps, cfg Config) (*kardia.Context, *tools.Registry) {
	t.Helper()
	root := kardia.NewContext()
	fibers, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(deps, cfg))
	if err != nil {
		t.Fatalf("装载失败：%v", err)
	}
	t.Cleanup(func() {
		for i := len(fibers) - 1; i >= 0; i-- {
			if err := fibers[i].Dispose(context.Background()); err != nil {
				t.Errorf("销毁失败：%v", err)
			}
		}
	})
	registry, err := tools.RegistryFrom(root)
	if err != nil {
		t.Fatalf("取注册表失败：%v", err)
	}
	return root, registry
}

func TestWorkspaceToolsOverRealFiles(t *testing.T) {
	registry, _ := workspace(t)
	root, toolset := install(t, Deps{Workspace: registry}, Config{})

	apps, err := toolset.Execute(root, "app_list", nil)
	if err != nil {
		t.Fatalf("列举工作区失败：%v", err)
	}
	records, ok := apps.([]domainapps.Record)
	if !ok || len(records) != 1 || records[0].Slug != "demo-app" {
		t.Fatalf("工作区列表不符：%v", apps)
	}

	lookup, err := toolset.Execute(root, "app_lookup", tools.Arguments{"slug": "demo-app"})
	if err != nil {
		t.Fatalf("查询工作区失败：%v", err)
	}
	if record := lookup.(domainapps.Record); record.DisplayName != "演示应用" {
		t.Fatalf("登记不符：%v", record)
	}

	directory, err := toolset.Execute(root, "app_directory", tools.Arguments{"slug": "demo-app"})
	if err != nil {
		t.Fatalf("取目录失败：%v", err)
	}
	fields := directory.(map[string]any)
	want := filepath.Join(registry.MountRoot, "elysian", "apps", "demo-app")
	if fields["directory"] != want {
		t.Fatalf("目录不符：%v，期望 %s", fields["directory"], want)
	}
	if !strings.HasPrefix(want, registry.MountRoot) {
		t.Fatalf("工作区必须落在挂载根下：%s", want)
	}

	files, err := toolset.Execute(root, "workspace_list_files", tools.Arguments{"slug": "demo-app"})
	if err != nil {
		t.Fatalf("列举文件失败：%v", err)
	}
	entries, ok := files.([]domainapps.FileEntry)
	if !ok || len(entries) < 2 {
		t.Fatalf("文件清单不符：%v", files)
	}

	content, err := toolset.Execute(root, "workspace_read_file", tools.Arguments{"slug": "demo-app", "path": ".env"})
	if err != nil {
		t.Fatalf("读文件失败：%v", err)
	}
	file, ok := content.(WorkspaceFile)
	if !ok || file.Content != "DEMO=1\n" || file.Slug != "demo-app" {
		t.Fatalf("文件内容不符：%v", content)
	}
}

func TestComposeCheckReportsReferences(t *testing.T) {
	registry, _ := workspace(t)
	root, toolset := install(t, Deps{Workspace: registry}, Config{})

	value, err := toolset.Execute(root, "compose_check", tools.Arguments{"slug": "demo-app", "compose": "compose.yaml"})
	if err != nil {
		t.Fatalf("自检失败：%v", err)
	}
	result, ok := value.(domainapps.CheckResult)
	if !ok {
		t.Fatalf("返回值类型不符：%T", value)
	}
	if !strings.HasSuffix(result.ComposePath, "compose.yaml") {
		t.Fatalf("compose 路径不符：%v", result.ComposePath)
	}
	if result.Coverage == "" {
		t.Fatal("自检必须给出判定范围")
	}
	for _, reference := range result.References {
		if !reference.Exists {
			t.Fatalf("引用的宿主路径应存在（测试已建好）：%v", reference)
		}
	}
}

func TestSlugAndPathValidationFailClosed(t *testing.T) {
	registry, _ := workspace(t)
	root, toolset := install(t, Deps{Workspace: registry}, Config{})

	cases := []struct {
		name string
		tool string
		args tools.Arguments
	}{
		{"标识越界", "app_lookup", tools.Arguments{"slug": "../evil"}},
		{"标识为空", "app_directory", tools.Arguments{"slug": ""}},
		{"读文件路径越界", "workspace_read_file", tools.Arguments{"slug": "demo-app", "path": "../../etc/passwd"}},
		{"未登记的工作区", "workspace_list_files", tools.Arguments{"slug": "nope"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := toolset.Execute(root, tc.tool, tc.args); err == nil {
				t.Fatalf("%s 应失败闭合", tc.tool)
			}
		})
	}
}

func TestRegistrySelfConstructionFromConfig(t *testing.T) {
	mountRoot := t.TempDir()
	root, toolset := install(t, Deps{}, Config{
		MountRoot:    mountRoot,
		RegistryPath: filepath.Join(t.TempDir(), "container-apps.json"),
	})

	value, err := toolset.Execute(root, "app_list", nil)
	if err != nil {
		t.Fatalf("空登记表应返回空列表：%v", err)
	}
	if records, ok := value.([]domainapps.Record); !ok || len(records) != 0 {
		t.Fatalf("应为空列表：%v", value)
	}
}

func TestMissingWorkspaceAndMountRootFailsClosed(t *testing.T) {
	root := kardia.NewContext()
	_, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(Deps{}, Config{}))
	if err == nil || !strings.Contains(err.Error(), "缺少工作区登记表") {
		t.Fatalf("登记表与挂载根都缺时装载应失败：%v", err)
	}
}

func TestBuildToolsAbsentWithoutManager(t *testing.T) {
	registry, _ := workspace(t)
	root, toolset := install(t, Deps{Workspace: registry}, Config{})

	service, err := From(root)
	if err != nil {
		t.Fatalf("取服务失败：%v", err)
	}
	if service.HasBuilds() {
		t.Fatal("未注入任务机时不应声称可用")
	}
	if size := toolset.Size(); size != 6 {
		t.Fatalf("未注入任务机时应只登记 6 条工具，实际 %d", size)
	}
	for _, name := range []string{"build_list", "build_get", "build_cancel"} {
		if _, err := toolset.Execute(root, name, tools.Arguments{"slug": "demo-app"}); err == nil ||
			!strings.Contains(err.Error(), "未注册") {
			t.Fatalf("%s 不应可用：%v", name, err)
		}
	}
	if _, err := service.ListBuilds(root, "demo-app"); err == nil ||
		!strings.Contains(err.Error(), "构建任务机未注入") {
		t.Fatalf("直接调用也应失败闭合：%v", err)
	}
	if _, err := service.GetBuild(root, "demo-app", "task-1"); err == nil {
		t.Fatal("取任务快照应失败闭合")
	}
	if err := service.CancelBuild(root, "demo-app", "task-1"); err == nil {
		t.Fatal("取消任务应失败闭合")
	}
}

type fakeBuildTasks struct {
	task      domainapps.BuildTask
	err       error
	cancelled string
}

func (f *fakeBuildTasks) List(slug string) []domainapps.BuildTask {
	if slug == f.task.Slug {
		return []domainapps.BuildTask{f.task}
	}
	return nil
}

func (f *fakeBuildTasks) Get(slug, id string) (domainapps.BuildTask, error) {
	if f.err != nil {
		return domainapps.BuildTask{}, f.err
	}
	if slug != f.task.Slug || id != f.task.ID {
		return domainapps.BuildTask{}, errors.New("任务不属于该工作区")
	}
	return f.task, nil
}

func (f *fakeBuildTasks) Cancel(slug, id string) error {
	if _, err := f.Get(slug, id); err != nil {
		return err
	}
	f.cancelled = id
	return nil
}

func TestBuildToolsUseInjectedTaskService(t *testing.T) {
	workspace, _ := workspace(t)
	builds := &fakeBuildTasks{task: domainapps.BuildTask{ID: "task-1", Slug: "demo-app", State: "running"}}
	root, registry := install(t, Deps{Workspace: workspace, Builds: builds}, Config{})
	if registry.Size() != 9 {
		t.Fatalf("应登记工作区与三条构建工具：%d", registry.Size())
	}
	value, err := registry.Execute(root, "build_list", tools.Arguments{"slug": "demo-app"})
	if err != nil || len(value.([]domainapps.BuildTask)) != 1 {
		t.Fatalf("列举任务失败：%v %v", value, err)
	}
	value, err = registry.Execute(root, "build_get", tools.Arguments{"slug": "demo-app", "task": "task-1"})
	if err != nil || value.(domainapps.BuildTask).State != "running" {
		t.Fatalf("任务快照不符：%v %v", value, err)
	}
	value, err = registry.Execute(root, "build_list", tools.Arguments{"slug": "missing"})
	if err != nil || value.([]domainapps.BuildTask) == nil {
		t.Fatalf("空列表应输出数组：%v %v", value, err)
	}
	for _, args := range []tools.Arguments{{"slug": "another-app", "task": "task-1"}, {"slug": "../escape", "task": "task-1"}, {"slug": "demo-app", "task": ""}} {
		if _, err := registry.Execute(root, "build_cancel", args); err == nil {
			t.Fatalf("无效目标不得取消：%v", args)
		}
	}
	if builds.cancelled != "" {
		t.Fatal("无效请求不得取消任务")
	}
	sentinel := errors.New("任务存储不可用")
	builds.err = sentinel
	if _, err := registry.Execute(root, "build_cancel", tools.Arguments{"slug": "demo-app", "task": "task-1"}); !errors.Is(err, sentinel) {
		t.Fatalf("域错误必须透传：%v", err)
	}
	builds.err = nil
	if _, err := registry.Execute(root, "build_cancel", tools.Arguments{"slug": "demo-app", "task": "task-1"}); err != nil {
		t.Fatal(err)
	}
	if builds.cancelled != "task-1" {
		t.Fatal("取消请求未传给宿主任务机")
	}
}

func TestTypedNilBuildTasksOmitOptionalTools(t *testing.T) {
	workspace, _ := workspace(t)
	root, registry := install(t, Deps{Workspace: workspace, Builds: (*fakeBuildTasks)(nil)}, Config{})
	service, err := From(root)
	if err != nil {
		t.Fatal(err)
	}
	if service.HasBuilds() || registry.Size() != 6 {
		t.Fatal("空任务机不得登记构建工具")
	}
}
