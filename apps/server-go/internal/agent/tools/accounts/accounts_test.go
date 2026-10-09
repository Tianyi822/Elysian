// 系统账号能力的测试：账号通道是替身，不 fork getent。
package accounts

import (
	"context"
	"errors"
	"strings"
	"testing"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/seam"
)

// fakeAccounts 是 seam.SystemAccounts 的替身。
type fakeAccounts struct {
	all    []seam.PasswdRecord
	byName map[string]seam.PasswdRecord
	err    error
}

func (f *fakeAccounts) PasswdAll(context.Context) ([]seam.PasswdRecord, error) {
	return f.all, f.err
}

func (f *fakeAccounts) PasswdByName(_ context.Context, name string) (*seam.PasswdRecord, error) {
	if f.err != nil {
		return nil, f.err
	}
	record, ok := f.byName[name]
	if !ok {
		return nil, nil
	}
	return &record, nil
}

func sampleAccounts() *fakeAccounts {
	return &fakeAccounts{
		all: []seam.PasswdRecord{
			{Name: "root", UID: 0, GID: 0, Home: "/root", Shell: "/bin/bash"},
			{Name: "ops", UID: 1000, GID: 1000, Home: "/home/ops", Shell: "/bin/bash"},
		},
		byName: map[string]seam.PasswdRecord{
			"ops": {Name: "ops", UID: 1000, GID: 1000, Home: "/home/ops", Shell: "/bin/bash"},
		},
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

func TestPluginRegistersThreeDescriptors(t *testing.T) {
	_, registry := install(t, Deps{Accounts: sampleAccounts()})
	if size := registry.Size(); size != 3 {
		t.Fatalf("应登记三条工具，实际 %d", size)
	}
	for _, name := range []string{"account_list", "account_lookup", "managed_uid_check"} {
		if _, ok := registry.Lookup(name); !ok {
			t.Fatalf("缺少工具 %s", name)
		}
	}
}

func TestAccountListReturnsRecords(t *testing.T) {
	root, registry := install(t, Deps{Accounts: sampleAccounts()})
	value, err := registry.Execute(root, "account_list", nil)
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	records, ok := value.([]seam.PasswdRecord)
	if !ok || len(records) != 2 || records[1].Name != "ops" {
		t.Fatalf("账号列表不符：%v", value)
	}
}

func TestAccountLookupFoundAndMissing(t *testing.T) {
	root, registry := install(t, Deps{Accounts: sampleAccounts()})

	value, err := registry.Execute(root, "account_lookup", tools.Arguments{"name": "ops"})
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	fields := value.(map[string]any)
	if fields["found"] != true {
		t.Fatalf("应命中：%v", fields)
	}
	record, ok := fields["record"].(seam.PasswdRecord)
	if !ok || record.UID != 1000 {
		t.Fatalf("记录不符：%v", fields["record"])
	}

	value, err = registry.Execute(root, "account_lookup", tools.Arguments{"name": "nobody-here"})
	if err != nil {
		t.Fatalf("查无结果不是错误：%v", err)
	}
	if fields := value.(map[string]any); fields["found"] != false {
		t.Fatalf("应显式标注未命中：%v", fields)
	}
}

func TestAccountLookupRejectsEmptyName(t *testing.T) {
	accounts := sampleAccounts()
	root, registry := install(t, Deps{Accounts: accounts})

	if _, err := registry.Execute(root, "account_lookup", tools.Arguments{"name": "  "}); err == nil {
		t.Fatal("空账号名应被拒")
	}
	if _, err := registry.Execute(root, "account_lookup", nil); err == nil ||
		!strings.Contains(err.Error(), "缺少必填参数") {
		t.Fatalf("缺参数应被参数模式拒绝：%v", err)
	}
}

func TestManagedUIDCheck(t *testing.T) {
	root, registry := install(t, Deps{Accounts: sampleAccounts()})

	for _, tc := range []struct {
		uid     int
		managed bool
	}{{0, false}, {1000, true}, {60001, false}} {
		value, err := registry.Execute(root, "managed_uid_check", tools.Arguments{"uid": tc.uid})
		if err != nil {
			t.Fatalf("执行失败：%v", err)
		}
		if fields := value.(map[string]any); fields["managed"] != tc.managed {
			t.Fatalf("UID %d 的判定应为 %v：%v", tc.uid, tc.managed, fields)
		}
	}
}

func TestDomainErrorPropagates(t *testing.T) {
	sentinel := errors.New("getent 不可用")
	root, registry := install(t, Deps{Accounts: &fakeAccounts{err: sentinel}})

	if _, err := registry.Execute(root, "account_list", nil); !errors.Is(err, sentinel) {
		t.Fatalf("域错误应原样穿透：%v", err)
	}
}

func TestMissingAccountsFailsClosed(t *testing.T) {
	root := kardia.NewContext()
	_, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(Deps{}))
	if err == nil || !strings.Contains(err.Error(), "缺少 seam.SystemAccounts") {
		t.Fatalf("缺少账号通道时装载应失败：%v", err)
	}
}
