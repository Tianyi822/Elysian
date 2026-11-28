package database

import (
	"context"
	"testing"
)

// Redis 容器接管：留空用户名时按 default 核验；无密码的实例（AUTH 关闭）不得凭空密码接管。
func TestAdoptDefaultsRedisUsernameAndRejectsPasswordless(t *testing.T) {
	service, admin, _, _ := adoptFixture(t, true, engineRedis)
	if _, err := service.Adopt(context.Background(), hexID("2"), "", "any-password"); err != nil {
		t.Fatalf("Redis 留空用户名应按 default 核验：%v", err)
	}
	if last := admin.targets[len(admin.targets)-1]; last.admin.Username != "default" {
		t.Fatalf("缺省用户名应为 default：%+v", last.admin)
	}
	// 无密码实例：任何密码都能登录（redis-cli 无 CONFIG requirepass 校验时 PING 通过）。
	// 接管入口要求密码非空，这里验证空密码被拒绝。
	if _, err := service.Adopt(context.Background(), hexID("2"), "default", ""); err == nil {
		t.Fatal("空密码不得接管")
	}
}
