package model

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func profileInput() Input {
	secret := "stored-test-secret"
	return Input{Provider: ProviderOpenAICompatible, APIFormat: FormatChatCompletions, Name: "本地模型", BaseURL: "http://127.0.0.1:11434/v1/", Model: "test-model", ContextTokens: 8192, OutputTokens: 1024, Capabilities: Capabilities{Text: true, Tools: true, Source: "用户配置"}, Active: true, Credential: &secret}
}

func TestProviderRevisionAndCredentialValidation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "models.json")
	store, _ := Open(path)
	in := profileInput()
	in.Provider, in.Model = ProviderDeepSeek, "deepseek-flash"
	created, err := store.Create(in)
	if err != nil || created.Provider != ProviderDeepSeek {
		t.Fatalf("供应商未保存：%+v %v", created, err)
	}
	in.Credential = nil
	updated, err := store.Update(created.ID, 1, in)
	if err != nil || updated.Provider != ProviderDeepSeek || !updated.HasCredential {
		t.Fatalf("DeepSeek 更新丢失凭据：%+v %v", updated, err)
	}
	reopened, err := Open(path)
	if err != nil || reopened.List()[0].Provider != ProviderDeepSeek {
		t.Fatalf("供应商持久化失败：%v", err)
	}
	empty := ""
	blank := "   "
	in.Credential = &blank
	_, err = store.Update(created.ID, 2, in)
	requireCode(t, err, "invalid-profile")
	in.Credential = &empty
	_, err = store.Update(created.ID, 2, in)
	requireCode(t, err, "invalid-profile")
	in.Active = false
	if _, err = store.Update(created.ID, 2, in); err != nil {
		t.Fatal(err)
	}
	in.Provider = "unknown"
	_, err = store.Create(in)
	requireCode(t, err, "invalid-profile")
	in.Provider = ""
	_, err = store.Create(in)
	requireCode(t, err, "invalid-profile")
	old, _ := store.Resolve(created.ID, 1, true)
	if old.Provider != ProviderDeepSeek || old.Credential != "stored-test-secret" {
		t.Fatal("供应商或凭据的旧修订被修改")
	}
}

func TestProfilesKeepImmutableRevisionsAndWriteOnlyCredentials(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config", "models.json")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	created, err := store.Create(profileInput())
	if err != nil {
		t.Fatal(err)
	}
	if created.Credential != "" || !created.HasCredential || created.Revision != 1 || strings.HasSuffix(created.BaseURL, "/") {
		t.Fatalf("公开配置错误：%+v", created)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("凭据文件权限错误：%v", err)
	}
	input := profileInput()
	input.Name, input.Credential = "更改后名称", nil
	updated, err := store.Update(created.ID, 1, input)
	if err != nil || updated.Revision != 2 {
		t.Fatalf("新增修订失败：%+v %v", updated, err)
	}
	old, err := store.Resolve(created.ID, 1, false)
	if err != nil || old.Name != "本地模型" || old.Credential != "stored-test-secret" {
		t.Fatal("旧修订被修改或凭据丢失")
	}
	current, _ := store.Resolve(created.ID, 2, false)
	if current.Credential != "stored-test-secret" {
		t.Fatal("未提交凭据时必须保留")
	}
	for _, value := range []any{created, updated, store.List(), current, current.Public()} {
		b, _ := json.Marshal(value)
		if strings.Contains(string(b), "stored-test-secret") || strings.Contains(string(b), `"credential"`) {
			t.Fatal("公开序列化泄露凭据")
		}
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := reopened.Resolve(created.ID, 1, true)
	if err != nil || restored.Credential != old.Credential {
		t.Fatal("重开后旧配置或凭据未保留")
	}
	if len(reopened.List()) != 1 || reopened.List()[0].Revision != 2 {
		t.Fatal("列表应只提供最新公开修订")
	}
}

func TestDisabledProfileBlocksNewRunsButResolvesAcceptedRevision(t *testing.T) {
	store, _ := Open(filepath.Join(t.TempDir(), "models.json"))
	created, err := store.Create(profileInput())
	if err != nil {
		t.Fatal(err)
	}
	input := profileInput()
	input.Active, input.Credential = false, nil
	if _, err := store.Update(created.ID, 1, input); err != nil {
		t.Fatal(err)
	}
	_, err = store.Resolve(created.ID, 1, false)
	requireCode(t, err, "profile-inactive")
	if old, err := store.Resolve(created.ID, 1, true); err != nil || old.Credential != "stored-test-secret" {
		t.Fatal("已接受运行必须仍可解析旧修订")
	}
	empty := ""
	input.Credential = &empty
	updated, err := store.Update(created.ID, 2, input)
	if err != nil || updated.HasCredential {
		t.Fatal("显式空凭据必须清除")
	}
	old, _ := store.Resolve(created.ID, 1, true)
	if old.Credential == "" {
		t.Fatal("清除新版本凭据不能改变旧版本")
	}
}

func TestConcurrentUpdateUsesExpectedRevision(t *testing.T) {
	store, _ := Open(filepath.Join(t.TempDir(), "models.json"))
	created, err := store.Create(profileInput())
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 16)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := store.Update(created.ID, 1, profileInput()); results <- err }()
	}
	wg.Wait()
	close(results)
	succeeded := 0
	for err := range results {
		if err == nil {
			succeeded++
		} else {
			requireCode(t, err, "revision-conflict")
		}
	}
	if succeeded != 1 || store.List()[0].Revision != 2 {
		t.Fatal("并发更新没有保持唯一的新修订")
	}
}

func TestFailedWriteDoesNotPublishRevision(t *testing.T) {
	store, _ := Open(filepath.Join(t.TempDir(), "models.json"))
	created, err := store.Create(profileInput())
	if err != nil {
		t.Fatal(err)
	}
	store.write = func(string, []Profile) (bool, error) { return false, storageError() }
	_, err = store.Update(created.ID, 1, profileInput())
	requireCode(t, err, "profile-storage")
	if store.List()[0].Revision != 1 {
		t.Fatal("失败的持久化不能发布修订")
	}
	reopened, err := Open(store.path)
	if err != nil || reopened.List()[0].Revision != 1 {
		t.Fatal("失败写入改变原文件")
	}
}

func TestProfilesRejectUnsafeURLsAndCorruptStorageWithoutSecretInErrors(t *testing.T) {
	for _, address := range []string{"file:///tmp/key", "https://user:password@example.test/v1", "https://example.test/v1?key=stored-test-secret", "https://example.test/v1#secret"} {
		store, _ := Open(filepath.Join(t.TempDir(), "models.json"))
		in := profileInput()
		in.BaseURL = address
		_, err := store.Create(in)
		requireCode(t, err, "invalid-profile")
		if strings.Contains(err.Error(), address) || strings.Contains(err.Error(), "stored-test-secret") {
			t.Fatal("错误包含凭据信息")
		}
	}
	path := filepath.Join(t.TempDir(), "models.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"profiles":[{"credential":"stored-test-secret"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := Open(path)
	requireCode(t, err, "profile-storage")
	if strings.Contains(err.Error(), "stored-test-secret") {
		t.Fatal("配置错误泄露凭据")
	}
}

func TestProfilesRejectSymlinkAndAllowCredentiallessLocalService(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target.json")
	if err := os.WriteFile(target, []byte(`{"version":1,"profiles":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link.json")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	_, err := Open(link)
	requireCode(t, err, "profile-storage")
	store, err := Open(filepath.Join(root, "new.json"))
	if err != nil {
		t.Fatal(err)
	}
	input := profileInput()
	input.Credential = nil
	created, err := store.Create(input)
	if err != nil || created.HasCredential {
		t.Fatalf("本地无凭据服务应可配置：%v", err)
	}
}
