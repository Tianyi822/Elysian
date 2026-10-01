package websites

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// 版本目录服务（websiteRuntimeCatalog.test.ts 5 例的 Go 对等）：缓存迁移、损坏回落、
// 并发合并、失败 stale、持久缓存跨实例。

// fakeCatalogCache 可控缓存假件。
type fakeCatalogCache struct {
	mu       sync.Mutex
	saved    []runtimeCatalogReport
	loadErr  bool
	saveErr  bool
	saveCall int
}

func (c *fakeCatalogCache) Load() (runtimeCatalogReport, bool) {
	return runtimeCatalogReport{}, false
}

func (c *fakeCatalogCache) Save(report runtimeCatalogReport) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.saveCall++
	if c.saveErr {
		return errors.New("磁盘不可写")
	}
	c.saved = append(c.saved, report)
	return nil
}

func TestCatalogCacheMigratesJavaShortcuts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtimes.json")
	report := runtimeReportFixture()
	// 缓存里塞入 java 主版本快捷项与省略零分量的 GA 版本。
	report.Catalog.Java = []catalogEntry{
		{Version: "17", Image: "eclipse-temurin:17_35-jre", Maintenance: MaintenanceLegacy, CheckedAt: "2026-09-30"},
		report.Catalog.Java[0],
		{Version: "17+35", Image: "eclipse-temurin:17_35-jre", Maintenance: MaintenanceLegacy, CheckedAt: "2026-09-30"},
	}
	data, err := marshalJSONCompact(report)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("写缓存失败：%v", err)
	}
	fetchCalls := 0
	service := NewRuntimeCatalogService(func(context.Context) (runtimeCatalog, error) {
		fetchCalls++
		return runtimeCatalog{}, errors.New("网络不可用")
	}, func() time.Time { return timeParseMillis(report.FetchedAt).Add(time.Millisecond) }, NewFileRuntimeCatalogCache(path), catalogCacheTTL)
	got, err := service.Get(context.Background())
	if err != nil {
		t.Fatalf("缓存命中应可用：%v", err)
	}
	versions := make([]string, 0, len(got.Catalog.Java))
	for _, entry := range got.Catalog.Java {
		versions = append(versions, entry.Version)
	}
	if strings.Join(versions, ",") != "17.0.1+12,17.0.0+35" {
		t.Fatalf("快捷项应剔除且零分量应展开，得到 %v", versions)
	}
	if fetchCalls != 0 {
		t.Fatalf("未过期缓存命中不应发请求")
	}
}

func TestCatalogBrokenCacheRefetches(t *testing.T) {
	fetchCalls := 0
	cache := &fakeCatalogCache{}
	service := NewRuntimeCatalogService(func(context.Context) (runtimeCatalog, error) {
		fetchCalls++
		return runtimeReportFixture().Catalog, nil
	}, nil, cache, catalogCacheTTL)
	got, err := service.Get(context.Background())
	if err != nil {
		t.Fatalf("获取失败：%v", err)
	}
	if got.Stale {
		t.Fatalf("新抓取不应标 stale")
	}
	if fetchCalls != 1 || cache.saveCall != 1 {
		t.Fatalf("应恰好一次抓取与一次落盘，得到 fetch=%d save=%d", fetchCalls, cache.saveCall)
	}
}

func TestCatalogConcurrentGetMerges(t *testing.T) {
	var mu sync.Mutex
	fetchCalls := 0
	now := timeParseMillis("2026-09-30T01:00:00.000Z").UnixMilli()
	publishedExtra := false
	service := NewRuntimeCatalogService(func(context.Context) (runtimeCatalog, error) {
		mu.Lock()
		defer mu.Unlock()
		fetchCalls++
		catalog := runtimeReportFixture().Catalog
		if publishedExtra {
			catalog.Node = append(catalog.Node, catalogEntry{Version: "24.22.0", Image: "node:24.22.0", Maintenance: MaintenanceMaintained, CheckedAt: "2026-09-30"})
		}
		return catalog, nil
	}, func() time.Time { return time.UnixMilli(now) }, nil, time.Second)
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := service.Get(context.Background()); err != nil {
				t.Errorf("并发 get 失败：%v", err)
			}
		}()
	}
	wg.Wait()
	if fetchCalls != 1 {
		t.Fatalf("并发读取应合并为一次抓取，得到 %d", fetchCalls)
	}
	// 过期后自动取得新发布的正式版本。
	now += 1001
	mu.Lock()
	publishedExtra = true
	mu.Unlock()
	got, err := service.Get(context.Background())
	if err != nil {
		t.Fatalf("过期后获取失败：%v", err)
	}
	found := false
	for _, entry := range got.Catalog.Node {
		if entry.Version == "24.22.0" {
			found = true
		}
	}
	if !found || fetchCalls != 2 {
		t.Fatalf("过期后应重新抓取并含新版本：found=%v fetch=%d", found, fetchCalls)
	}
}

func TestCatalogRefreshFailureShowsStale(t *testing.T) {
	var mu sync.Mutex
	fetchCalls := 0
	now := timeParseMillis("2026-09-30T00:00:00.000Z").UnixMilli()
	healthy := true
	service := NewRuntimeCatalogService(func(context.Context) (runtimeCatalog, error) {
		mu.Lock()
		defer mu.Unlock()
		fetchCalls++
		if !healthy {
			return runtimeCatalog{}, errors.New("网络不可用")
		}
		return runtimeReportFixture().Catalog, nil
	}, func() time.Time { return time.UnixMilli(now) }, nil, time.Second)
	first, err := service.Get(context.Background())
	if err != nil {
		t.Fatalf("首次获取失败：%v", err)
	}
	now += 1001
	mu.Lock()
	healthy = false
	mu.Unlock()
	stale, err := service.Get(context.Background())
	if err != nil {
		t.Fatalf("刷新失败应回落缓存：%v", err)
	}
	if !stale.Stale || stale.Detail == nil || !strings.Contains(*stale.Detail, "上次获取的缓存") {
		t.Fatalf("应标 stale 并注明回落，得到 %+v", stale)
	}
	if marshalAnyValue(stale.Catalog) == nil {
		t.Fatalf("stale 应带原目录")
	}
	// 60 秒重试延迟内不再发请求。
	now += 30 * 1000
	if _, err := service.Get(context.Background()); err != nil {
		t.Fatalf("重试延迟内应直接用缓存：%v", err)
	}
	if fetchCalls != 2 {
		t.Fatalf("重试延迟内不应再抓取，得到 %d", fetchCalls)
	}
	// 无缓存首败明确报错。
	if _, err := NewRuntimeCatalogService(func(context.Context) (runtimeCatalog, error) {
		return runtimeCatalog{}, errors.New("网络不可用")
	}, nil, nil, 0).Get(context.Background()); err == nil || !strings.Contains(err.Error(), "无法获取正式运行时版本") {
		t.Fatalf("无缓存首败应 503，得到 %v", err)
	}
	_ = first
}

func TestCatalogPersistentCacheAcrossInstances(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "runtimes.json")
	cache := NewFileRuntimeCatalogCache(path)
	report := runtimeReportFixture()
	if err := cache.Save(report); err != nil {
		t.Fatalf("落缓存失败：%v", err)
	}
	fetchCalls := 0
	fetchErr := func(context.Context) (runtimeCatalog, error) {
		fetchCalls++
		return runtimeCatalog{}, errors.New("网络不可用")
	}
	fresh := NewRuntimeCatalogService(fetchErr, func() time.Time { return timeParseMillis(report.FetchedAt).Add(time.Millisecond) }, cache, catalogCacheTTL)
	got, err := fresh.Get(context.Background())
	if err != nil {
		t.Fatalf("持久缓存应跨实例复用：%v", err)
	}
	if got.FetchedAt != report.FetchedAt || fetchCalls != 0 {
		t.Fatalf("应原样命中缓存不发请求：fetchedAt=%s fetch=%d", got.FetchedAt, fetchCalls)
	}
	// 7 小时后过期（TTL 6h）→ 重新获取，失败则回落 stale。
	stale := NewRuntimeCatalogService(fetchErr, func() time.Time { return timeParseMillis(report.FetchedAt).Add(7 * time.Hour) }, cache, catalogCacheTTL)
	result, err := stale.Get(context.Background())
	if err != nil {
		t.Fatalf("过期后获取失败：%v", err)
	}
	if !result.Stale {
		t.Fatalf("过期缓存抓取失败应标 stale")
	}
	if fetchCalls != 1 {
		t.Fatalf("过期后应尝试一次抓取，得到 %d", fetchCalls)
	}
}

// timeParseMillis 解析毫秒精度 ISO 串。
func timeParseMillis(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339Nano, value)
	return parsed
}
