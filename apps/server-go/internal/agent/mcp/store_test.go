package mcp

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sampleInput() Input {
	secret := "test-secret-mcp"
	return Input{Name: "测试服务", Transport: "streamable-http", URL: "https://example.test/mcp", Credential: &secret, Active: true}
}
func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var p *Error
	if !errors.As(err, &p) || p.Code != code {
		t.Fatalf("预期 %s，实际 %v", code, err)
	}
}
func sampleCatalog() Catalog {
	return Catalog{ProtocolVersion: ProtocolVersion, Capabilities: Capabilities{Tools: true}, Tools: []Tool{{Name: "check", InputSchema: json.RawMessage(`{"type":"object","properties":{"n":{"type":"integer"}},"additionalProperties":false}`)}}, Resources: []Resource{}, Prompts: []Prompt{}}
}

func TestImmutableServersAndPermanentRevocation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config", "agent-mcp-servers.json")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.Create(sampleInput())
	if err != nil {
		t.Fatal(err)
	}
	if p.Credential != "" || !p.HasCredential {
		t.Fatal("公开配置泄露或遗漏凭据状态")
	}
	cat, err := s.SaveCatalog(p.ID, 1, sampleCatalog())
	if err != nil {
		t.Fatal(err)
	}
	in := sampleInput()
	in.Name = "新名称"
	in.Active = false
	in.Credential = nil
	updated, err := s.Update(p.ID, 1, in)
	if err != nil || updated.Revision != 2 {
		t.Fatalf("更新失败：%v", err)
	}
	_, err = s.Resolve(p.ID, 1, false)
	requireCode(t, err, "mcp-inactive")
	old, err := s.Resolve(p.ID, 1, true)
	if err != nil || old.Name != "测试服务" || old.Credential != "test-secret-mcp" {
		t.Fatal("历史修订丢失")
	}
	for _, v := range []any{old, old.Public(), s.List()} {
		b, _ := json.Marshal(v)
		if strings.Contains(string(b), "test-secret-mcp") {
			t.Fatal("JSON 泄露凭据")
		}
	}
	loaded, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := loaded.Catalog(p.ID, 1, cat.Digest)
	if err != nil || got.Digest != cat.Digest {
		t.Fatal("目录快照未持久化")
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatal("凭据文件权限错误")
	}
	in.Revoked = true
	if _, err = s.Update(p.ID, 2, in); err != nil {
		t.Fatal(err)
	}
	_, err = s.Resolve(p.ID, 1, true)
	requireCode(t, err, "mcp-revoked")
	in.Revoked = false
	_, err = s.Update(p.ID, 3, in)
	requireCode(t, err, "mcp-revoked")
}
func TestStoreFailureAndSecretEnvironment(t *testing.T) {
	s, _ := Open(filepath.Join(t.TempDir(), "servers.json"))
	env := map[string]string{"TOKEN": "stdio-secret"}
	p, err := s.Create(Input{Name: "容器", Transport: "stdio", Stdio: &ContainerInput{Image: "example:test", Command: []string{"serve"}, Environment: &env}, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if !p.Stdio.HasEnvironment || len(p.Stdio.Environment) > 0 {
		t.Fatal("公开投影泄露环境")
	}
	internal, _ := s.Resolve(p.ID, 1, true)
	internal.Stdio.Environment["TOKEN"] = "mutated"
	original, _ := s.Resolve(p.ID, 1, true)
	if original.Stdio.Environment["TOKEN"] != "stdio-secret" {
		t.Fatal("解析结果修改了配置")
	}
	s.write = func(string, []Server, []storedCatalog) (bool, error) { return false, storageError() }
	_, err = s.Create(sampleInput())
	requireCode(t, err, "mcp-storage")
	if len(s.List()) != 1 {
		t.Fatal("失败写入仍发布状态")
	}
}

func TestStdioGrantReferencesPersistAsImmutablePublicConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "servers.json")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	input := Input{Name: "带授权容器", Transport: "stdio", Active: true, Stdio: &ContainerInput{Image: "example:test", Command: []string{"serve"}, GrantID: "grant-00000000000000000000000000000000", GrantRevision: 1}}
	first, err := s.Create(input)
	if err != nil {
		t.Fatal(err)
	}
	if first.Stdio.GrantID != input.Stdio.GrantID || first.Stdio.GrantRevision != 1 {
		t.Fatal("公开配置丢失固定授权")
	}
	input.Stdio.GrantRevision = 2
	second, err := s.Update(first.ID, 1, input)
	if err != nil || second.Stdio.GrantRevision != 2 {
		t.Fatalf("授权修订更新失败：%+v %v", second, err)
	}
	loaded, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	old, err := loaded.Resolve(first.ID, 1, true)
	if err != nil || old.Stdio.GrantRevision != 1 {
		t.Fatalf("历史授权被修改：%+v %v", old, err)
	}
	old.Stdio.GrantID = "changed"
	still, err := loaded.Resolve(first.ID, 1, true)
	if err != nil || still.Stdio.GrantID != input.Stdio.GrantID {
		t.Fatal("公开副本修改影响配置")
	}
	input.Stdio.GrantID = ""
	input.Stdio.GrantRevision = 0
	cleared, err := loaded.Update(first.ID, 2, input)
	if err != nil || cleared.Stdio.GrantID != "" || cleared.Stdio.GrantRevision != 0 {
		t.Fatalf("无法显式清除授权：%+v %v", cleared, err)
	}
	for _, ref := range []struct {
		id       string
		revision int
	}{{"", 1}, {"", -1}, {"invalid", 1}, {"grant-00000000000000000000000000000000", 0}, {"grant-00000000000000000000000000000000", -1}} {
		input.Stdio.GrantID = ref.id
		input.Stdio.GrantRevision = ref.revision
		_, err = loaded.Create(input)
		requireCode(t, err, "invalid-mcp-grant")
	}
}
func TestRejectDuplicateStorageKeysAndSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "servers.json")
	if err := os.WriteFile(target, []byte(`{"version":1,"version":1,"servers":[],"catalogs":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := Open(target)
	requireCode(t, err, "mcp-storage")
	link := filepath.Join(root, "link.json")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	_, err = Open(link)
	requireCode(t, err, "mcp-storage")
}
func TestCatalogImmutableAndUnknownConstraintsRejected(t *testing.T) {
	s, _ := Open(filepath.Join(t.TempDir(), "servers.json"))
	p, _ := s.Create(sampleInput())
	a, err := s.SaveCatalog(p.ID, 1, sampleCatalog())
	if err != nil {
		t.Fatal(err)
	}
	b := sampleCatalog()
	b.Tools[0].Description = "能力已改变"
	b, err = s.SaveCatalog(p.ID, 1, b)
	if err != nil || b.Digest == a.Digest {
		t.Fatalf("不同目录摘要错误：%v", err)
	}
	old, _ := s.Catalog(p.ID, 1, a.Digest)
	if old.Tools[0].Description != "" {
		t.Fatal("旧目录被修改")
	}
	current, _ := s.Catalog(p.ID, 1, "")
	if current.Digest != b.Digest {
		t.Fatal("当前目录错误")
	}
	if _, err = s.SaveCatalog(p.ID, 1, sampleCatalog()); err != nil {
		t.Fatal(err)
	}
	current, _ = s.Catalog(p.ID, 1, "")
	if current.Digest != a.Digest {
		t.Fatal("恢复旧目录后当前指针错误")
	}
	bad := sampleCatalog()
	bad.Tools[0].InputSchema = json.RawMessage(`{"type":"object","madeUpConstraint":true}`)
	if _, err = s.SaveCatalog(p.ID, 1, bad); err == nil {
		t.Fatal("未知约束被静默忽略")
	}
}
