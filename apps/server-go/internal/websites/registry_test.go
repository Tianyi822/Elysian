package websites

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// 网站登记（websitesRegistry.test.ts 5 例的 Go 对等）：双实现行为一致 + 文件实现的
// 原子写与串行队列。测试全部落在临时目录，不碰开发者真实的 ~/.Elysian。

func registryRow(id string, overrides func(*WebsiteRecord)) WebsiteRecord {
	name := "站点-" + id
	record := WebsiteRecord{
		ID:             id,
		Kind:           KindNode,
		Name:           name,
		Port:           3000,
		RuntimeVersion: stringPtr("24.21.0"),
		RootDir:        "/srv/wwwroot/" + name,
		Domain:         nil,
		AccessMode:     AccessModeDirect,
		Certificate:    nil,
		ContainerName:  stringPtr("elysian-site-0123456789ab"),
		ContainerID:    stringPtr("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
		ImageRef:       stringPtr("node:24.21.0"),
		DeployCommand:  stringPtr("tail -f /dev/null"),
		Enabled:        false,
		Category:       CategoryDevelopment,
		ExpiryAt:       nil,
		Note:           nil,
		GitURL:         nil,
		CreatedAt:      "2026-09-29T00:00:00.000Z",
	}
	if overrides != nil {
		overrides(&record)
	}
	return record
}

// assertRegistryBehaviors 双实现共用的行为断言：两份实现对同一套行为各跑一遍。
func assertRegistryBehaviors(t *testing.T, registry Registry) {
	t.Helper()
	ctx := context.Background()
	if err := registry.Put(ctx, registryRow("w-1", nil)); err != nil {
		t.Fatalf("put 失败：%v", err)
	}
	rows, _ := registry.List(ctx)
	if len(rows) != 1 || rows[0].ID != "w-1" {
		t.Fatalf("put 后应有一行")
	}
	if err := registry.Put(ctx, registryRow("w-2", nil)); err != nil {
		t.Fatalf("put 失败：%v", err)
	}
	if err := registry.Put(ctx, registryRow("w-1", func(r *WebsiteRecord) { r.Note = stringPtr("更新备注") })); err != nil {
		t.Fatalf("put 失败：%v", err)
	}
	rows, _ = registry.List(ctx)
	if len(rows) != 2 {
		t.Fatalf("同 id put 应替换不新增")
	}
	for _, row := range rows {
		if row.ID == "w-1" && (row.Note == nil || *row.Note != "更新备注") {
			t.Fatalf("w-1 备注应更新")
		}
	}
	if err := registry.Remove(ctx, "w-1"); err != nil {
		t.Fatalf("remove 失败：%v", err)
	}
	rows, _ = registry.List(ctx)
	if len(rows) != 1 || rows[0].ID != "w-2" {
		t.Fatalf("remove 后应只剩 w-2")
	}
	// list 返回副本：外部改动不影响登记。
	snapshot, _ := registry.List(ctx)
	snapshot[0].Name = "外部改写"
	again, _ := registry.List(ctx)
	if again[0].Name == "外部改写" {
		t.Fatalf("list 应返回副本")
	}
}

func TestMemoryRegistry(t *testing.T) {
	assertRegistryBehaviors(t, NewMemoryWebsiteRegistry())
}

func TestFileRegistry(t *testing.T) {
	registry := NewFileWebsiteRegistry(filepath.Join(t.TempDir(), "websites.json"))
	assertRegistryBehaviors(t, registry)
}

func TestFileRegistryPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "websites.json")
	registry := NewFileWebsiteRegistry(path)
	if err := registry.Put(context.Background(), registryRow("w-1", func(r *WebsiteRecord) { r.Name = "官网门户" })); err != nil {
		t.Fatalf("put 失败：%v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("登记文件应落盘：%v", err)
	}
	var persisted []map[string]any
	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatalf("登记应持久化为 JSON 数组：%v", err)
	}
	if len(persisted) != 1 || persisted[0]["name"] != "官网门户" {
		t.Fatalf("持久化内容不符：%s", data)
	}
	if err := registry.Remove(context.Background(), "w-1"); err != nil {
		t.Fatalf("remove 失败：%v", err)
	}
	data, _ = os.ReadFile(path)
	if string(data) != "[]" {
		t.Fatalf("remove 后文件应同步为空数组，得到 %s", data)
	}
	reopened := NewFileWebsiteRegistry(path)
	rows, err := reopened.List(context.Background())
	if err != nil || len(rows) != 0 {
		t.Fatalf("重开实例应可读：%v", err)
	}
}

func TestFileRegistryConcurrentWrites(t *testing.T) {
	registry := NewFileWebsiteRegistry(filepath.Join(t.TempDir(), "websites.json"))
	var wg sync.WaitGroup
	for index := 0; index < 20; index++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			_ = registry.Put(context.Background(), registryRow(fmt.Sprintf("w-%d", index), nil))
		}(index)
	}
	wg.Wait()
	rows, err := registry.List(context.Background())
	if err != nil {
		t.Fatalf("list 失败：%v", err)
	}
	if len(rows) != 20 {
		t.Fatalf("20 笔并发 put 应全部落账，得到 %d 行", len(rows))
	}
	ids := map[string]struct{}{}
	for _, row := range rows {
		ids[row.ID] = struct{}{}
	}
	if len(ids) != 20 {
		t.Fatalf("串行队列应防交错，得到 %d 个不同 id", len(ids))
	}
}

func TestFileRegistryCorruptedContent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "websites.json")
	registry := NewFileWebsiteRegistry(path)
	if err := registry.Put(context.Background(), registryRow("w-1", nil)); err != nil {
		t.Fatalf("put 失败：%v", err)
	}
	if err := os.WriteFile(path, []byte(`{"corrupted":true}`), 0o600); err != nil {
		t.Fatalf("写损坏内容失败：%v", err)
	}
	if _, err := registry.List(context.Background()); err == nil || err.Error() != "网站登记文件无效" {
		t.Fatalf("损坏内容应显式报错不静默清空，得到 %v", err)
	}
}
