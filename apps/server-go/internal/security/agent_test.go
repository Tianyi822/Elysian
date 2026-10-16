package security

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestAgentSecurityNeverProjectsKeyMaterialOrUserNotes(t *testing.T) {
	secret := "DO_NOT_EXPOSE_MATERIAL"
	ssh := &fakeSshAPI{rootAuth: SshRootAuth{Policy: "prohibit-password", Key: &SshRootKey{Algorithm: "ed25519", Fingerprint: "SHA256:fingerprint", PublicKey: secret, PrivateKey: &secret}}}
	users := &fakeUsersAPI{users: []HostUser{{ID: "1001", Name: "operator", Note: &secret}}}
	calls := 0
	facade := NewAgentFacade(Deps{Available: true, ssh: ssh, users: users, AgentAuthorize: func(context.Context) error { calls++; return nil }})
	for _, call := range []func(context.Context) (any, error){facade.Snapshot, facade.Users} {
		value, err := call(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(value)
		if strings.Contains(string(raw), secret) {
			t.Fatalf("key or note leaked: %s", raw)
		}
	}
	if calls != 2 {
		t.Fatalf("authorization calls=%d", calls)
	}
	if _, err := NewAgentFacade(Deps{Available: true, ssh: ssh, users: users}).Snapshot(context.Background()); err == nil {
		t.Fatal("missing authority accepted")
	}
}
