package model

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 非回环主机的明文 HTTP 地址携带凭据必须被拒绝，防止 Bearer 凭据经网络明文发送。
func TestProfilesRejectCredentialOverNonLoopbackHTTP(t *testing.T) {
	for _, address := range []string{"http://example.test:11434/v1", "http://192.168.1.10:11434/v1"} {
		store, _ := Open(filepath.Join(t.TempDir(), "models.json"))
		in := profileInput()
		in.BaseURL = address
		_, err := store.Create(in)
		requireCode(t, err, "invalid-profile")
		if strings.Contains(err.Error(), "stored-test-secret") {
			t.Fatal("错误包含凭据信息")
		}
	}
}

// 回环主机不经过外部网络，保留本地明文服务携带凭据的组合。
func TestProfilesAllowCredentialOverLoopbackHTTP(t *testing.T) {
	for _, address := range []string{"http://127.0.0.1:11434/v1", "http://localhost:11434/v1", "http://[::1]:11434/v1"} {
		store, _ := Open(filepath.Join(t.TempDir(), "models.json"))
		in := profileInput()
		in.BaseURL = address
		if _, err := store.Create(in); err != nil {
			t.Fatalf("回环 HTTP 地址应允许携带凭据：%v", err)
		}
	}
}

// 请求接缝复用同一校验，绕过存储层直接请求也必须在发出前被拒绝。
func TestCompleteRejectsCredentialOverNonLoopbackHTTPBeforeNetwork(t *testing.T) {
	p := testProfile("http://model-plaintext.test/v1")
	p.Credential = "runtime-secret"
	_, err := NewClient(nil).Complete(context.Background(), p, testRequest())
	requireCode(t, err, "invalid-profile")
	if strings.Contains(err.Error(), "runtime-secret") {
		t.Fatal("错误包含凭据信息")
	}
}

// 历史文件中的非回环明文凭据记录整体拒载，保持失败关闭；报错指明条目与原因但不泄露凭据。
func TestStoredNonLoopbackHTTPCredentialFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "models.json")
	id := "model-" + strings.Repeat("7", 32)
	stored := `{"version":1,"profiles":[{"id":"` + id + `","revision":1,"name":"明文模型","baseUrl":"http://192.168.1.10:11434/v1","model":"test-model","provider":"openai-compatible","apiFormat":"chat-completions","contextTokens":8192,"outputTokens":1024,"capabilities":{"text":true,"tools":true,"source":"用户配置"},"active":true,"credential":"legacy-secret"}]}`
	if err := os.WriteFile(path, []byte(stored), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := Open(path)
	requireCode(t, err, "profile-storage")
	if strings.Contains(err.Error(), "legacy-secret") {
		t.Fatal("存储错误泄露凭据")
	}
	if !strings.Contains(err.Error(), id) || !strings.Contains(err.Error(), "回环") {
		t.Fatalf("报错未指明条目与原因：%v", err)
	}
}
