// 登录鉴权能力的测试：用域自带的内存存诸，不碰 ~/.Elysian 里的真实文件。
package auth

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domainauth "elysian/server/internal/auth"
)

// baseTime 是注入时钟的固定基准，断言不依赖真实时间。
var baseTime = time.Date(2026, 10, 9, 10, 0, 0, 0, time.UTC)

func memoryDeps(t *testing.T, credentials *domainauth.PanelCredentials) Deps {
	t.Helper()
	return Deps{
		Sessions:    domainauth.NewMemorySessionStore(func() time.Time { return baseTime }),
		Credentials: domainauth.NewMemoryCredentialsStore(credentials),
		Origins:     domainauth.NewMemoryReturnOriginRegistry([]string{"http://127.0.0.1:48200"}),
	}
}

func install(t *testing.T, deps Deps) (*kardia.Context, *tools.Registry) {
	t.Helper()
	root := kardia.NewContext()
	fibers, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(deps))
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

func TestSessionCountDoesNotLeakSessionIDs(t *testing.T) {
	deps := memoryDeps(t, nil)
	if _, _, err := deps.Sessions.Create("epoch-1", ""); err != nil {
		t.Fatalf("建会话失败：%v", err)
	}
	root, registry := install(t, deps)

	value, err := registry.Execute(root, "session_count", nil)
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	fields := value.(map[string]any)
	if fields["count"] != 1 {
		t.Fatalf("会话数不符：%v", fields)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("结果应可序列化：%v", err)
	}
	sessions, err := deps.Sessions.List()
	if err != nil || len(sessions) != 1 {
		t.Fatalf("取会话失败：%v %v", sessions, err)
	}
	if strings.Contains(string(encoded), sessions[0].ID) {
		t.Fatalf("会话 ID 是登录凭据，不得进工具结果：%s", encoded)
	}
}

func TestCredentialsStatusNeverCarriesHash(t *testing.T) {
	deps := memoryDeps(t, &domainauth.PanelCredentials{
		Username:          "admin",
		PasswordHash:      "scrypt$secret-hash-value",
		PasswordChangedAt: "2026-10-01T00:00:00Z",
	})
	root, registry := install(t, deps)

	value, err := registry.Execute(root, "credentials_status", nil)
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	status, ok := value.(CredentialsStatus)
	if !ok || !status.Initialized || status.Username != "admin" || status.PasswordChangedAt != "2026-10-01T00:00:00Z" {
		t.Fatalf("凭据状态不符：%v", value)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("结果应可序列化：%v", err)
	}
	if strings.Contains(string(encoded), "secret-hash-value") {
		t.Fatalf("密码哈希不得进工具结果：%s", encoded)
	}
}

func TestCredentialsStatusReportsUninitialized(t *testing.T) {
	root, registry := install(t, memoryDeps(t, nil))

	value, err := registry.Execute(root, "credentials_status", nil)
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	if status := value.(CredentialsStatus); status.Initialized {
		t.Fatalf("无凭据时应报告未初始化：%v", status)
	}
}

func TestReturnOriginsList(t *testing.T) {
	root, registry := install(t, memoryDeps(t, nil))

	value, err := registry.Execute(root, "return_origins_list", nil)
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	origins, ok := value.([]string)
	if !ok || len(origins) != 1 || origins[0] != "http://127.0.0.1:48200" {
		t.Fatalf("白名单不符：%v", value)
	}
}

func TestMissingStoresFailClosed(t *testing.T) {
	full := memoryDeps(t, nil)
	cases := []struct {
		name   string
		deps   Deps
		needle string
	}{
		{"全缺", Deps{}, "缺少会话存诸"},
		{"缺凭据", Deps{Sessions: full.Sessions, Origins: full.Origins}, "缺少凭据存诸"},
		{"缺白名单", Deps{Sessions: full.Sessions, Credentials: full.Credentials}, "缺少回跳白名单"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := kardia.NewContext()
			_, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(tc.deps))
			if err == nil || !strings.Contains(err.Error(), tc.needle) {
				t.Fatalf("期望错误含 %q，实际：%v", tc.needle, err)
			}
		})
	}
}
