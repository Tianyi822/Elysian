package app

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	execconfig "elysian/server/internal/agent/execution/config"
)

// TestParentErrorHandlerPanicResponseSanitized 断言父层 panic 兜底不回显 panic
// 原文（可能含绝对路径或内部状态细节），细节只落 server.http 运行日志。
func TestParentErrorHandlerPanicResponseSanitized(t *testing.T) {
	const secretMarker = "/var/lib/secret/panel-state"
	appLogs := &fakeLogsService{}
	handler := parentErrorHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		panic(errors.New("读取 " + secretMarker + " 失败：内部细节"))
	}), appLogs)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/agent/runs/run-1", nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("状态码 = %d，期望 500；响应体 %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Body.String(); !strings.Contains(got, "服务内部错误") || strings.Contains(got, secretMarker) {
		t.Fatalf("panic 响应未净化：%s", got)
	}
	if len(appLogs.runtimes) != 1 {
		t.Fatalf("运行日志条数 = %d，期望 1", len(appLogs.runtimes))
	}
	if entry := appLogs.runtimes[0]; entry[0] != "error" || entry[1] != "server.http" || !strings.Contains(entry[2], secretMarker) {
		t.Fatalf("panic 细节未落运行日志：%+v", entry)
	}
}

// 停用的执行授权必须被解析拒绝：停用即紧急切断，不能再为 MCP stdio 容器
// 挂载业务目录，也不允许停用授权参与任何新的容器创建。
func TestResolveExecutionGrantRejectsDisabledGrant(t *testing.T) {
	root := t.TempDir()
	mountRoot := filepath.Join(root, "srv")
	if err := os.MkdirAll(mountRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	store, err := execconfig.Open(filepath.Join(root, "config", "agent", "execution.json"), execconfig.Options{MountRoot: mountRoot})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	grant, err := store.PutGrant(execconfig.GrantInput{Name: "测试授权", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := resolveExecutionGrant(store, grant.ID, grant.Revision)
	if err != nil || resolved == nil || resolved.ID != grant.ID {
		t.Fatalf("启用中的授权应正常解析：%v %+v", err, resolved)
	}
	disabled, err := store.SetGrantEnabled(grant.ID, grant.Revision, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = resolveExecutionGrant(store, disabled.ID, disabled.Revision); err == nil || !strings.Contains(err.Error(), "已停用") {
		t.Fatalf("停用的授权必须拒绝解析：%v", err)
	}
	if _, err = resolveExecutionGrant(nil, "grant-any", 0); err == nil {
		t.Fatal("配置不可用时必须拒绝解析")
	}
}
