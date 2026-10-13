package model

import (
	"errors"
	"path/filepath"
	"testing"
)

func serviceInput() ServiceInput {
	secret := "fake-key"
	return ServiceInput{Name: "测试服务", Provider: ProviderOpenAICompatible, APIFormat: FormatResponses, BaseURL: "http://127.0.0.1:1234/v1", Active: true, Credential: &secret, Models: []ServiceModelInput{
		{Model: "a", ContextTokens: 8192, OutputTokens: 4096, Capabilities: Capabilities{Text: true, Tools: true, Source: "测试"}, Enabled: true},
		{Model: "b", ContextTokens: 8192, OutputTokens: 4096, Capabilities: Capabilities{Text: true, Tools: true, Source: "测试"}, Enabled: false},
	}}
}
func TestServiceAtomicSaveCredentialsAndRevisions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "models.json")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	input := serviceInput()
	secret := "fake-key"
	input.Credential = &secret
	service, err := store.CreateService(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(service.Models) != 2 || service.Revision != 1 || !service.HasCredential || service.Models[1].Active || service.Models[1].Enabled {
		t.Fatalf("服务配置不符：%+v", service)
	}
	if service.Models[0].Credential != "" {
		t.Fatal("公开凭据泄漏")
	}
	original := store.write
	writes := 0
	store.write = func(path string, profiles []Profile) (bool, error) { writes++; return original(path, profiles) }
	input.Credential = nil
	for i := range input.Models {
		input.Models[i].ID = service.Models[i].ID
	}
	input.Models[1].ContextTokens = 0
	if _, err = store.UpdateService(service.ID, 1, input); err == nil || writes != 0 || store.Services()[0].Revision != 1 {
		t.Fatal("验证失败部分提交")
	}
	input.Models[1].ContextTokens = 8192
	input.Active = false
	service, err = store.UpdateService(service.ID, 1, input)
	if err != nil {
		t.Fatal(err)
	}
	if writes != 1 || service.Models[0].Active || !service.Models[0].Enabled || !service.HasCredential {
		t.Fatal("共用凭据或独立开关丢失")
	}
	if _, err = store.UpdateService(service.ID, 1, input); err == nil || writes != 1 {
		t.Fatal("CAS 冲突被接收")
	}
	store.write = func(string, []Profile) (bool, error) { return false, errors.New("fake disk failure") }
	if _, err = store.UpdateService(service.ID, 2, input); err == nil || store.Services()[0].Revision != 2 {
		t.Fatal("失败修改内存")
	}
	store.write = original
	input.Active = true
	input.Models = input.Models[:1]
	empty := ""
	input.Credential = &empty
	if _, err = store.UpdateService(service.ID, 2, input); err == nil {
		t.Fatal("空 API Key 的服务保存被接收")
	}
	replacement := "replacement-key"
	input.Credential = &replacement
	service, err = store.UpdateService(service.ID, 2, input)
	if err != nil {
		t.Fatal(err)
	}
	if !service.HasCredential || len(store.List()) != 1 || len(service.Models) != 1 || !service.Models[0].Active {
		t.Fatal("替换凭据或移除模型失败")
	}
	if _, err = store.Resolve(input.Models[0].ID, 1, true); err != nil {
		t.Fatal("旧修订丢失", err)
	}
	removedID := store.records[1].ID
	if _, err = store.Resolve(removedID, 1, false); err == nil {
		t.Fatal("移除模型仍允许新运行")
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Services()[0]; got.APIFormat != FormatResponses || got.Revision != 3 || len(got.Models) != 1 || !got.HasCredential {
		t.Fatalf("持久化不符：%+v", got)
	}
}
func TestServiceKeyAndMembership(t *testing.T) {
	store, _ := Open(filepath.Join(t.TempDir(), "models.json"))
	input := serviceInput()
	empty := ""
	input.Credential = &empty
	for _, provider := range []string{ProviderOpenAICompatible, ProviderDeepSeek} {
		input.Provider = provider
		if _, err := store.CreateService(input); err == nil {
			t.Fatalf("%s 服务无 API Key 仍被接收", provider)
		}
		input.Active = false
		if _, err := store.CreateService(input); err == nil {
			t.Fatalf("%s 服务停用即允许无 API Key", provider)
		}
		input.Active = true
	}
	input.Provider = ProviderDeepSeek
	secret := "fake-key"
	input.Credential = &secret
	service, err := store.CreateService(input)
	if err != nil {
		t.Fatal(err)
	}
	input.Models[0].ID = "foreign"
	if _, err = store.UpdateService(service.ID, 1, input); err == nil {
		t.Fatal("其他服务模型被加入")
	}
	input.Models[0].ID = service.Models[0].ID
	input.Models[1].ID = service.Models[1].ID
	input.Models[1].Model = input.Models[0].Model
	if _, err = store.UpdateService(service.ID, 1, input); err == nil {
		t.Fatal("重复标识被接收")
	}
	if _, err = store.Update(service.Models[0].ID, 1, Input{}); err == nil {
		t.Fatal("单模型更新绕过服务 CAS")
	}
}
