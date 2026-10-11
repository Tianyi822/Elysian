package harness

import (
	"strings"
	"testing"
)

// 明文 HTTP 的 Embedding 地址携带凭据时仅允许回环主机，防止 Bearer 凭据
// 明文出网——与模型服务地址（model.validateProfile）同一约束口径。
func TestEmbeddingProfileRejectsHTTPCredentialOutsideLoopback(t *testing.T) {
	secret := "embedding-secret"
	_, err := embeddingFromInput(EmbeddingProfileInput{Name: "远端嵌入", BaseURL: "http://embed.example.com/v1", Model: "embed-v1", Dimensions: 64, Active: true, Credential: &secret}, "", "emb-1", 1)
	if err == nil || !strings.Contains(err.Error(), "回环") {
		t.Fatalf("远端明文 HTTP 地址携带凭据必须拒绝：%v", err)
	}
	local, err := embeddingFromInput(EmbeddingProfileInput{Name: "本机嵌入", BaseURL: "http://127.0.0.1:11434/v1", Model: "embed-v1", Dimensions: 64, Active: true, Credential: &secret}, "", "emb-2", 1)
	if err != nil {
		t.Fatalf("回环明文 HTTP 地址携带凭据应允许：%v", err)
	}
	if local.Credential == "" || !local.HasCredential {
		t.Fatal("回环配置应保留凭据")
	}
	if _, err = embeddingFromInput(EmbeddingProfileInput{Name: "无凭据远端", BaseURL: "http://embed.example.com/v1", Model: "embed-v1", Dimensions: 64}, "", "emb-3", 1); err != nil {
		t.Fatalf("无凭据的明文 HTTP 地址不应受此约束：%v", err)
	}
}
