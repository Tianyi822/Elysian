package websites

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"elysian/server/internal/shared"
)

/*
 * 运行时版本目录服务（websiteRuntimeCatalog.ts 逐字移植）：懒获取、六小时缓存、
 * 并发合并；更新失败保留自动获取过的目录并明确标为过期（60 秒后重试）。
 */

// 缓存 TTL 与失败重试延迟。
const (
	catalogCacheTTL   = 6 * time.Hour
	catalogRetryDelay = 60 * time.Second
)

// pureDigitsVersion java 主版本快捷项（缓存迁移时剔除）。
var pureDigitsVersion = regexp.MustCompile(`^\d+$`)

// catalogSource 版本目录服务视图（service 消费；生产实现为 catalogService）。
type catalogSource interface {
	Get(ctx context.Context) (runtimeCatalogReport, error)
}

// catalogCache 缓存视图：load 回 (nil, false) 视为无缓存。
type catalogCache interface {
	Load() (runtimeCatalogReport, bool)
	Save(report runtimeCatalogReport) error
}

// NewFileRuntimeCatalogCache 文件版缓存：load 时做缓存形状迁移——剔除 java 主版本
// 快捷项、对其余项展开初始 GA 零分量，再过统一校验；任何异常视为无缓存。save 写
// `<path>.tmp`（0600，固定临时名，与登记的随机后缀不同）后 rename。
func NewFileRuntimeCatalogCache(path string) catalogCache {
	return &fileRuntimeCatalogCache{path: path}
}

type fileRuntimeCatalogCache struct {
	path string
}

func (c *fileRuntimeCatalogCache) Load() (runtimeCatalogReport, bool) {
	data, err := os.ReadFile(c.path)
	if err != nil {
		return runtimeCatalogReport{}, false
	}
	var cached any
	if err := json.Unmarshal(data, &cached); err != nil {
		return runtimeCatalogReport{}, false
	}
	// 缓存只保留完整版本：移除主版本快捷项，并展开初始 GA 的零分量。复用已有正式
	// 补丁与准确镜像，断网时也无需等六小时刷新。
	if row, ok := cached.(map[string]any); ok {
		if catalog, ok := row["catalog"].(map[string]any); ok {
			if java, ok := catalog["java"].([]any); ok {
				migrated := make([]any, 0, len(java))
				for _, item := range java {
					entry, ok := item.(map[string]any)
					if !ok {
						migrated = append(migrated, item)
						continue
					}
					version, isText := entry["version"].(string)
					if isText && pureDigitsVersion.MatchString(version) {
						continue
					}
					if isText {
						entry["version"] = NormalizeWebsiteJavaReleaseVersion(version)
					}
					migrated = append(migrated, entry)
				}
				catalog["java"] = migrated
			}
		}
	}
	report, err := ParseWebsiteRuntimeCatalogReport(cached)
	if err != nil {
		return runtimeCatalogReport{}, false
	}
	return report, true
}

func (c *fileRuntimeCatalogCache) Save(report runtimeCatalogReport) error {
	if err := os.MkdirAll(filepath.Dir(c.path), 0o755); err != nil {
		return err
	}
	data, err := marshalJSONCompact(report)
	if err != nil {
		return err
	}
	temporary := c.path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, c.path)
}

// NewRuntimeCatalogService 目录服务：fetch 为官方抓取闭包，now 可控时钟，ttl 缺省
// 六小时。fetch/now/cache 皆可注入（测试假件）。
func NewRuntimeCatalogService(fetch func(ctx context.Context) (runtimeCatalog, error), now func() time.Time, cache catalogCache, ttl time.Duration) catalogSource {
	if now == nil {
		now = time.Now
	}
	if ttl <= 0 {
		ttl = catalogCacheTTL
	}
	if fetch == nil {
		fetch = func(ctx context.Context) (runtimeCatalog, error) {
			return FetchWebsiteRuntimeCatalog(ctx, &http.Client{}, now().UTC().Format("2006-01-02"))
		}
	}
	return &catalogService{fetch: fetch, now: now, cache: cache, ttl: ttl}
}

// catalogFlight 持有本次抓取的结果，关闭 done 后所有等待者读取同一份。
type catalogFlight struct {
	done   chan struct{}
	report runtimeCatalogReport
	err    error
}

// catalogService 懒初始化 + TTL 缓存 + 在飞行合并。
type catalogService struct {
	fetch   func(ctx context.Context) (runtimeCatalog, error)
	now     func() time.Time
	cache   catalogCache
	ttl     time.Duration
	mu      sync.Mutex
	init    chan struct{} // 首次 Get 时懒加载缓存
	current *runtimeCatalogReport
	next    time.Time
	flight  *catalogFlight
}

// initialize 读缓存一次：缓存 fetchedAt <= now 才采用，nextRefreshAt = fetchedAt+ttl；
// 缓存不可读或无效时直接从官方重新获取。
func (s *catalogService) initialize() {
	defer close(s.init)
	if s.cache == nil {
		return
	}
	saved, ok := s.cache.Load()
	if !ok {
		return
	}
	fetchedAt, err := time.Parse(time.RFC3339Nano, saved.FetchedAt)
	if err != nil {
		return
	}
	now := s.now()
	if !fetchedAt.After(now) {
		s.mu.Lock()
		s.current = &saved
		s.next = fetchedAt.Add(s.ttl)
		s.mu.Unlock()
	}
}

// refresh 抓取官方目录：成功经统一校验后更新 current 并落缓存（缓存写失败仅在
// detail 注记）；失败时无 current 抛 503，有 current 标 stale 并 60s 后重试。
func (s *catalogService) refresh() (runtimeCatalogReport, error) {
	catalog, err := s.fetch(context.Background())
	if err == nil {
		if verr := validateTypedCatalog(catalog); verr != nil {
			err = verr
		}
	}
	if err == nil {
		report := runtimeCatalogReport{
			Catalog:   catalog,
			FetchedAt: s.now().UTC().Format("2006-01-02T15:04:05.000Z07:00"),
			Stale:     false,
			Detail:    nil,
		}
		if s.cache != nil {
			if serr := s.cache.Save(report); serr != nil {
				detail := "版本目录已更新，持久缓存写入失败"
				report.Detail = &detail
			}
		}
		s.mu.Lock()
		s.current = &report
		s.next = s.now().Add(s.ttl)
		s.mu.Unlock()
		return report, nil
	}
	detail := err.Error()
	if detail == "" {
		detail = "官方版本目录获取失败"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current == nil {
		return runtimeCatalogReport{}, &shared.InvalidRequestError{
			Status:  503,
			Message: fmt.Sprintf("无法获取正式运行时版本：%s", detail),
		}
	}
	stale := *s.current
	stale.Stale = true
	note := "版本目录更新失败，正在使用上次获取的缓存：" + detail
	stale.Detail = &note
	s.current = &stale
	s.next = s.now().Add(catalogRetryDelay)
	return stale, nil
}

// Get 缓存未过期直接返回；过期则合并刷新。请求取消只结束当前等待，不取消共享工作。
// 初始化完成先于新鲜度判定（对齐 TS await initialized 的次序，缓存命中不发请求）。
func (s *catalogService) Get(ctx context.Context) (runtimeCatalogReport, error) {
	if err := ctx.Err(); err != nil {
		return runtimeCatalogReport{}, err
	}
	s.mu.Lock()
	if s.init == nil {
		s.init = make(chan struct{})
		go s.initialize()
	}
	init := s.init
	s.mu.Unlock()
	select {
	case <-ctx.Done():
		return runtimeCatalogReport{}, ctx.Err()
	case <-init:
	}

	s.mu.Lock()
	if err := ctx.Err(); err != nil {
		s.mu.Unlock()
		return runtimeCatalogReport{}, err
	}
	if s.current != nil && s.now().Before(s.next) {
		current := s.current
		s.mu.Unlock()
		return *current, nil
	}
	if s.flight == nil {
		flight := &catalogFlight{done: make(chan struct{})}
		s.flight = flight
		go func() {
			flight.report, flight.err = s.refresh()
			s.mu.Lock()
			s.flight = nil
			close(flight.done)
			s.mu.Unlock()
		}()
	}
	flight := s.flight
	s.mu.Unlock()
	select {
	case <-ctx.Done():
		return runtimeCatalogReport{}, ctx.Err()
	case <-flight.done:
		if err := ctx.Err(); err != nil {
			return runtimeCatalogReport{}, err
		}
		return flight.report, flight.err
	}
}
