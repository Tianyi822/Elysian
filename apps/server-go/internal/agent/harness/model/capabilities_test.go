package model

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestServiceModelCapabilitiesRoundTripAndIsolation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "models.json")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	input := serviceInput()
	want := Capabilities{Text: true, Tools: true, Image: true, PDF: true, StructuredOutput: true, SystemMessages: true, ReasoningLevels: []string{"disabled", "medium", "xhigh"}, Source: "用户确认"}
	input.Models[0].Capabilities = want.clone()
	created, err := store.CreateService(input)
	if err != nil {
		t.Fatal(err)
	}
	id := created.Models[0].ID
	input.Models[0].Capabilities.ReasoningLevels[0] = "changed"
	created.Models[0].Capabilities.ReasoningLevels[1] = "changed"
	resolved, err := store.Resolve(id, 1, true)
	if err != nil || !reflect.DeepEqual(resolved.Capabilities, want) {
		t.Fatalf("输入或公开对象修改污染已保存配置：%+v %v", resolved.Capabilities, err)
	}
	resolved.Capabilities.ReasoningLevels[2] = "changed"
	if again, _ := store.Resolve(id, 1, true); !reflect.DeepEqual(again.Capabilities, want) {
		t.Fatal("解析对象修改污染固定修订")
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := reopened.Resolve(id, 1, true); !reflect.DeepEqual(got.Capabilities, want) {
		t.Fatalf("重启后能力丢失：%+v", got.Capabilities)
	}
	input = serviceInput()
	for i := range input.Models {
		input.Models[i].ID = created.Models[i].ID
	}
	input.Models[0].Capabilities = want.clone()
	input.Models[0].Capabilities.SystemMessages = false
	input.Models[0].Capabilities.ReasoningLevels = []string{}
	if _, err = reopened.UpdateService(created.ID, 1, input); err != nil {
		t.Fatal(err)
	}
	reopened, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := reopened.Resolve(id, 2, true)
	if err != nil || got.Capabilities.SystemMessages || len(got.Capabilities.ReasoningLevels) != 0 || !got.Capabilities.Image {
		t.Fatalf("显式清除或关闭未保留：%+v %v", got.Capabilities, err)
	}
	if old, _ := reopened.Resolve(id, 1, true); !reflect.DeepEqual(old.Capabilities, want) {
		t.Fatal("修改能力影响了旧修订")
	}
}

func TestRejectInvalidReasoningLevelsBeforeSaving(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "models.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, levels := range [][]string{{"low", "low"}, {""}, {"with space"}, {strings.Repeat("x", 33)}, make([]string, 17)} {
		input := profileInput()
		input.Capabilities.ReasoningLevels = levels
		_, err := store.Create(input)
		requireCode(t, err, "invalid-profile")
	}
	if len(store.List()) != 0 {
		t.Fatal("无效配置被保存")
	}
}
