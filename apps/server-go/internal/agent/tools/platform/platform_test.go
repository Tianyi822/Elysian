package platform

import (
	"context"
	"testing"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domain "elysian/server/internal/platform"
)

func TestSampleScopeEnum(t *testing.T) {
	for _, test := range []struct {
		scope                 string
		wantProcess, wantHost bool
		wantErr               bool
	}{
		{"", true, false, false},
		{"process", true, false, false},
		{"host", false, true, false},
		{"both", true, true, false},
		{"invalid", false, false, true},
	} {
		wantProcess, wantHost, err := sampleScope(test.scope)
		if (err != nil) != test.wantErr || wantProcess != test.wantProcess || wantHost != test.wantHost {
			t.Fatalf("scope=%q 得到 (%v,%v,%v)", test.scope, wantProcess, wantHost, err)
		}
	}
}

func TestSampleDescriptorRegisteredWithLegacyNames(t *testing.T) {
	root := kardia.NewContext()
	t.Cleanup(func() { _ = root.Fiber().Dispose(context.Background()) })
	fibers, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(Deps{Facade: &domain.AgentFacade{}}, Config{}))
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
		t.Fatal(err)
	}
	schemas := map[string]tools.PublicSchema{}
	for _, schema := range registry.Schemas() {
		schemas[schema.Name] = schema
	}
	sample, ok := schemas["platform_sample"]
	if !ok {
		t.Fatal("platform_sample 未注册")
	}
	if sample.Metadata != (tools.Metadata{Domain: "platform", Backend: "domain", Action: "sample", Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, Version: "1"}) {
		t.Fatalf("sample 元数据不符：%+v", sample.Metadata)
	}
	properties, _ := sample.Parameters["properties"].(map[string]any)
	scope, _ := properties["scope"].(map[string]any)
	values, _ := scope["enum"].([]any)
	if len(values) != 3 || values[0] != "process" || values[1] != "host" || values[2] != "both" {
		t.Fatalf("scope 枚举不符：%v", values)
	}
	// 旧名保留注册供旧快照恢复。
	for _, legacy := range []string{"platform_memory", "platform_metrics"} {
		if _, kept := schemas[legacy]; !kept {
			t.Fatalf("旧工具 %s 必须保留注册供旧快照恢复", legacy)
		}
	}
}
