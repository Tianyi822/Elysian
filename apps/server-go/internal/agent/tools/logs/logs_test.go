// 日志能力的测试：全程用替身，不打开任何 sqlite 句柄。
package logs

import (
	"context"
	"strings"
	"testing"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/seam"
)

type runtimeCall struct {
	level, source, message string
}

// fakeLogs 是 seam.Logs 的替身，记录全部写入。
type fakeLogs struct {
	runtime    []runtimeCall
	operations []seam.OperationRecord
}

func (f *fakeLogs) Runtime(level, source, message string) {
	f.runtime = append(f.runtime, runtimeCall{level: level, source: source, message: message})
}

func (f *fakeLogs) RecordOperation(record seam.OperationRecord) {
	f.operations = append(f.operations, record)
}

// install 装载注册表与日志能力，测试结束自动逆序销毁。
func install(t *testing.T, deps Deps, cfg Config) (*kardia.Context, *tools.Registry, []*kardia.Fiber) {
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
	return root, registry, fibers
}

func TestPluginRegistersTwoDescriptors(t *testing.T) {
	_, registry, _ := install(t, Deps{Logs: &fakeLogs{}}, Config{})
	schemas := registry.Schemas()
	if len(schemas) != 2 || schemas[0].Name != "log_operation_write" || schemas[1].Name != "log_runtime_write" {
		t.Fatalf("描述符不符：%v", schemas)
	}
}

func TestMissingLogsFailsClosed(t *testing.T) {
	root := kardia.NewContext()
	_, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(Deps{}, Config{}))
	if err == nil {
		t.Fatal("缺少 seam.Logs 时装载应失败")
	}
	if !strings.Contains(err.Error(), "缺少 seam.Logs") {
		t.Fatalf("错误应说明缺失的依赖：%v", err)
	}
	if size := root.Registry().Size(); size != 0 {
		t.Fatalf("失败后应回滚，实际留下 %d 条运行时", size)
	}
}

func TestRuntimeWriteUsesConfiguredSource(t *testing.T) {
	logs := &fakeLogs{}
	root, registry, _ := install(t, Deps{Logs: logs}, Config{Source: "巡检"})

	value, err := registry.Execute(root, "log_runtime_write", tools.Arguments{"level": "warning", "message": "磁盘使用率偏高"})
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	result, ok := value.(map[string]any)
	if !ok || result["written"] != true || result["source"] != "巡检" {
		t.Fatalf("返回值不符：%v", value)
	}
	if len(logs.runtime) != 1 || logs.runtime[0] != (runtimeCall{level: "warning", source: "巡检", message: "磁盘使用率偏高"}) {
		t.Fatalf("写入不符：%v", logs.runtime)
	}
}

func TestRuntimeWriteOverridesSource(t *testing.T) {
	logs := &fakeLogs{}
	root, registry, _ := install(t, Deps{Logs: logs}, Config{})
	if _, err := registry.Execute(root, "log_runtime_write", tools.Arguments{
		"level": "info", "message": "来自容器区", "source": "containers",
	}); err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	if logs.runtime[0].source != "containers" {
		t.Fatalf("来源应被参数覆盖：%v", logs.runtime[0])
	}
}

func TestRuntimeWriteRejectsBadArguments(t *testing.T) {
	logs := &fakeLogs{}
	root, registry, _ := install(t, Deps{Logs: logs}, Config{})

	cases := []struct {
		name   string
		args   tools.Arguments
		needle string
	}{
		{"级别不在枚举内", tools.Arguments{"level": "trace", "message": "x"}, "不在允许范围内"},
		{"正文为空", tools.Arguments{"level": "info", "message": ""}, "minLength"},
		{"缺级别", tools.Arguments{"message": "x"}, "缺少必填参数"},
		{"多带未声明参数", tools.Arguments{"level": "info", "message": "x", "extra": 1}, "未在参数模式中声明"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := registry.Execute(root, "log_runtime_write", tc.args)
			if err == nil {
				t.Fatal("应失败闭合")
			}
			if !strings.Contains(err.Error(), tc.needle) {
				t.Fatalf("期望错误含 %q，实际：%v", tc.needle, err)
			}
			if len(logs.runtime) != 0 {
				t.Fatalf("被拒的调用不得写入：%v", logs.runtime)
			}
		})
	}
}

func TestOperationWriteCarriesOptionalFields(t *testing.T) {
	logs := &fakeLogs{}
	root, registry, _ := install(t, Deps{Logs: logs}, Config{})

	_, err := registry.Execute(root, "log_operation_write", tools.Arguments{
		"category": "containers", "action": "restart", "result": "success",
		"method": "POST", "path": "/api/docker/containers/abc/restart",
		"target": "abc", "summary": "重启容器", "http_status": 200,
	})
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	if len(logs.operations) != 1 {
		t.Fatalf("应写入一条操作日志：%v", logs.operations)
	}
	record := logs.operations[0]
	if record.Category != "containers" || record.Action != "restart" || record.Result != "success" {
		t.Fatalf("字段不符：%v", record)
	}
	if record.Target == nil || *record.Target != "abc" {
		t.Fatalf("target 未透传：%v", record.Target)
	}
	if record.Summary == nil || *record.Summary != "重启容器" {
		t.Fatalf("summary 未透传：%v", record.Summary)
	}
	if record.HTTPStatus == nil || *record.HTTPStatus != 200 {
		t.Fatalf("http_status 未透传：%v", record.HTTPStatus)
	}
}

func TestOperationWriteRejectsLowercaseMethodAndUnknownCategory(t *testing.T) {
	logs := &fakeLogs{}
	root, registry, _ := install(t, Deps{Logs: logs}, Config{})
	base := tools.Arguments{
		"category": "containers", "action": "restart", "result": "success",
		"method": "POST", "path": "/api/docker",
	}

	lowercase := tools.Arguments{}
	for key, value := range base {
		lowercase[key] = value
	}
	lowercase["method"] = "post"
	if _, err := registry.Execute(root, "log_operation_write", lowercase); err == nil || !strings.Contains(err.Error(), "必须大写") {
		t.Fatalf("小写方法应被拒，实际：%v", err)
	}

	unknown := tools.Arguments{}
	for key, value := range base {
		unknown[key] = value
	}
	unknown["category"] = "kubernetes"
	if _, err := registry.Execute(root, "log_operation_write", unknown); err == nil || !strings.Contains(err.Error(), "不在允许范围内") {
		t.Fatalf("未知分类应被拒，实际：%v", err)
	}
	if len(logs.operations) != 0 {
		t.Fatalf("被拒的调用不得写入：%v", logs.operations)
	}
}

func TestServiceMethodsAreCallableDirectly(t *testing.T) {
	logs := &fakeLogs{}
	root, _, fibers := install(t, Deps{Logs: logs}, Config{})

	service, err := From(root)
	if err != nil {
		t.Fatalf("取服务失败：%v", err)
	}
	if service.Source() != DefaultSource {
		t.Fatalf("缺省来源应为 %q，实际 %q", DefaultSource, service.Source())
	}
	if err := service.WriteRuntime(root, "error", "agent", "数据库连接失败"); err != nil {
		t.Fatalf("直接写入失败：%v", err)
	}
	if err := service.WriteRuntime(root, "fatal", "agent", "x"); err == nil {
		t.Fatal("非法级别应被拒")
	}
	if err := service.RecordOperation(root, seam.OperationRecord{Category: "auth", Action: "login", Result: "failure", Method: "POST", Path: "/api/auth"}); err != nil {
		t.Fatalf("直接写操作日志失败：%v", err)
	}
	if err := service.RecordOperation(root, seam.OperationRecord{Category: "auth"}); err == nil {
		t.Fatal("缺字段的操作日志应被拒")
	}
	if len(logs.runtime) != 1 || len(logs.operations) != 1 {
		t.Fatalf("写入次数不符：%v %v", logs.runtime, logs.operations)
	}

	if err := fibers[1].Dispose(context.Background()); err != nil {
		t.Fatalf("销毁失败：%v", err)
	}
	if _, err := From(root); err == nil {
		t.Fatal("销毁后应取不到服务")
	}
}
