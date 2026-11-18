package database

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"elysian/server/internal/agent/tools"
)

// 退役工具契约：13 个 database_* 描述符保留注册供旧 Run 按固定 CatalogDigest
// 派发，逐名执行均返回同一固定退役业务错误（未派发）；Deps 已无 Facade，
// 处理器为纯固定返回，不触数据库域、协议或 Docker，无任何副作用。
// 参数校验仍按保留定义执行——退役不放宽冻结约束。

func newDatabaseRuntime(t *testing.T) *tools.Runtime {
	t.Helper()
	runtime, err := tools.NewRuntime(context.Background(), Plugin(Deps{}, Config{}))
	if err != nil {
		t.Fatalf("装载数据库工具运行时失败：%v", err)
	}
	t.Cleanup(func() {
		if err := runtime.Close(context.Background()); err != nil {
			t.Errorf("销毁数据库工具运行时失败：%v", err)
		}
	})
	return runtime
}

// retiredToolCases 按名给出能通过冻结参数校验的最小合法参数。
var retiredToolCases = []struct {
	name string
	args map[string]any
}{
	{"database_list", nil},
	{"database_metadata", map[string]any{"id": "row-1"}},
	{"database_metrics", map[string]any{"id": "row-1"}},
	{"database_discover", map[string]any{"engine": "MySQL", "versionTag": "8.4"}},
	{"database_create", map[string]any{"id": "new:mysql", "engine": "MySQL", "versionTag": "8.4", "name": "orders", "expected": "missing", "requestId": strings.Repeat("a", 64)}},
	{"database_reconcile", map[string]any{"id": "row-1", "expected": "v1", "requestId": strings.Repeat("b", 64)}},
	{"database_remove", map[string]any{"id": "row-1", "expected": "v1"}},
	{"database_container_remove", map[string]any{"id": "row-1", "expected": "v1"}},
	{"database_start", map[string]any{"id": "row-1", "expected": "v1"}},
	{"database_stop", map[string]any{"id": "row-1", "expected": "v1"}},
	{"database_task_status", map[string]any{"id": "row-1", "taskId": "task-1"}},
	{"database_task_logs", map[string]any{"id": "row-1", "taskId": "task-1"}},
	{"database_task_cancel", map[string]any{"id": "row-1", "taskId": "task-1"}},
}

func TestRetiredDatabaseToolsReturnFixedBusinessErrorWithoutSideEffects(t *testing.T) {
	runtime := newDatabaseRuntime(t)
	if schemas := runtime.Schemas(); len(schemas) != len(retiredToolCases) {
		t.Fatalf("应恰好注册 %d 个 database_* 描述符，实际 %d", len(retiredToolCases), len(schemas))
	}
	for _, testCase := range retiredToolCases {
		t.Run(testCase.name, func(t *testing.T) {
			var metadata *tools.Metadata
			for _, schema := range runtime.Schemas() {
				if schema.Name == testCase.name {
					metadata = &schema.Metadata
					break
				}
			}
			if metadata == nil {
				t.Fatalf("退役工具 %s 仍在注册表", testCase.name)
			}
			if metadata.Domain != "database" || metadata.Exposure != "agent" {
				t.Fatalf("退役工具元数据不得改写：%+v", *metadata)
			}
			// 冻结元数据仍参与派发匹配：异步标记与任务域必须与退役前一致。
			if testCase.name == "database_create" || testCase.name == "database_reconcile" {
				if !metadata.Async || metadata.TaskDomain != "database" || metadata.TaskRequestArgument != "requestId" {
					t.Fatalf("异步元数据不得改写：%+v", *metadata)
				}
			}
			value, err := runtime.Execute(context.Background(), testCase.name, testCase.args)
			var business *tools.BusinessError
			if !errors.As(err, &business) {
				t.Fatalf("退役工具应返回业务错误：%v", err)
			}
			if business.Code != "database-retired" || business.Message != "数据库独立工具已退役，数据库容器请使用 Docker 工具管理" || !business.NotDispatched {
				t.Fatalf("退役回执不符：%+v", business)
			}
			if value != nil {
				t.Fatalf("退役工具不得返回业务结果：%v", value)
			}
		})
	}
}

func TestRetiredDatabaseToolsKeepFrozenArgumentConstraints(t *testing.T) {
	runtime := newDatabaseRuntime(t)
	for _, testCase := range []struct{ name, args string }{
		{"database_discover", `{"engine":"Oracle","versionTag":"8.4"}`},
		{"database_create", `{"id":"new:mysql","engine":"MySQL","versionTag":"8.4","expected":"missing","requestId":"` + strings.Repeat("a", 64) + `"}`},
		{"database_remove", `{"id":"row-1","expected":"v1","unapproved":true}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			var args map[string]any
			if json.Unmarshal([]byte(testCase.args), &args) != nil {
				t.Fatal("参数解析失败")
			}
			_, err := runtime.Execute(context.Background(), testCase.name, args)
			var business *tools.BusinessError
			if !errors.As(err, &business) || business.Code != "tool-arguments-rejected" {
				t.Fatalf("越权或非法参数仍应被冻结参数校验拒绝：%v", err)
			}
		})
	}
}
