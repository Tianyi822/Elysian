package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

func TestEmbeddingUsageRecordsIndexQueryAndUnknownSeparately(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if call == 1 {
			_, _ = w.Write([]byte(`{"data":[{"embedding":[1,0]}],"usage":{"prompt_tokens":7,"total_tokens":7,"prompt_tokens_details":{"cached_tokens":0}}}`))
			return
		}
		if call == 2 {
			_, _ = w.Write([]byte(`{"data":[{"embedding":[0,1]}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"embedding":[1]}],"usage":{"prompt_tokens":9,"total_tokens":9}}`))
	}))
	defer server.Close()
	m, _, _ := agentManager(t, func(context.Context, model.Profile, model.Request) (model.Response, error) {
		return finalReply("完成"), nil
	}, func(deps *Deps) { deps.Path = filepath.Join(t.TempDir(), "data", "harness.sqlite") })
	ctx := context.Background()
	profile, err := m.CreateEmbeddingProfile(ctx, EmbeddingProfileInput{Name: "用量测试", BaseURL: server.URL, Model: "embedding", Dimensions: 2, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	page := WikiRef{PageID: "page-one", Revision: 1, Digest: strings.Repeat("a", 64)}
	if _, err = m.embeddingComplete(ctx, profile, "私有页面正文", EmbeddingRequest{Purpose: "index", JobID: "index-one", Page: &page}); err != nil {
		t.Fatal(err)
	}
	if _, err = m.embeddingComplete(ctx, profile, "私有查询原文", EmbeddingRequest{Purpose: "query"}); err != nil {
		t.Fatal(err)
	}
	if _, err = m.embeddingComplete(ctx, profile, "请求已计费但向量无效", EmbeddingRequest{Purpose: "query"}); err == nil {
		t.Fatal("错误维度未拒绝")
	}
	records, err := m.ListEmbeddingRequests(ctx, "", 2)
	if err != nil || len(records.Items) != 2 || records.NextCursor == "" {
		t.Fatalf("用量分页失败：%+v %v", records, err)
	}
	failed, unknown := records.Items[0], records.Items[1]
	if failed.Status != StateFailed || failed.Usage.TotalTokens == nil || *failed.Usage.TotalTokens != 9 {
		t.Fatalf("失败响应遗失已报告用量：%+v", failed)
	}
	if unknown.Purpose != "query" || unknown.Status != StateSucceeded || unknown.Usage.TotalTokens != nil || unknown.Usage.CachedTokens != nil || unknown.EstimatedTokens <= 0 {
		t.Fatalf("未知用量被当作已知：%+v", unknown)
	}
	older, err := m.ListEmbeddingRequests(ctx, records.NextCursor, 2)
	if err != nil || len(older.Items) != 1 {
		t.Fatalf("用量分页漏记录：%+v %v", older, err)
	}
	index := older.Items[0]
	if index.Purpose != "index" || index.JobID != "index-one" || index.Page == nil || *index.Page != page || index.Usage.PromptTokens == nil || *index.Usage.PromptTokens != 7 || index.Usage.CachedTokens == nil || *index.Usage.CachedTokens != 0 {
		t.Fatalf("索引用量与关联丢失：%+v", index)
	}
	raw, _ := json.Marshal(records)
	if strings.Contains(string(raw), "私有") || strings.Contains(string(raw), "credential") || strings.Contains(string(raw), "embedding\":") {
		t.Fatalf("公开用量泄露输入：%s", raw)
	}
}

func TestEmbeddingMaintenanceGuardRejectsConfigAndProviderWrites(t *testing.T) {
	var maintenance atomic.Bool
	m, _, _ := agentManager(t, func(context.Context, model.Profile, model.Request) (model.Response, error) {
		return finalReply("完成"), nil
	}, func(deps *Deps) {
		deps.Path = filepath.Join(t.TempDir(), "data", "harness.sqlite")
		deps.DispatchGuard = func() error {
			if maintenance.Load() {
				return bad("maintenance-active", "面板维护中")
			}
			return nil
		}
	})
	ctx := context.Background()
	input := EmbeddingProfileInput{Name: "维护测试", BaseURL: "http://127.0.0.1:9", Model: "embedding", Dimensions: 2, Active: true}
	profile, err := m.CreateEmbeddingProfile(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	maintenance.Store(true)
	if _, err = m.CreateEmbeddingProfile(ctx, input); err == nil {
		t.Fatal("维护期间创建了配置")
	}
	if _, err = m.UpdateEmbeddingProfile(ctx, profile.ID, profile.Revision, input); err == nil {
		t.Fatal("维护期间更新了配置")
	}
	if _, err = m.embeddingComplete(ctx, profile, "查询", EmbeddingRequest{Purpose: "query"}); err == nil {
		t.Fatal("维护期间发起了向量请求")
	}
	records, err := m.ListEmbeddingRequests(ctx, "", 50)
	if err != nil || len(records.Items) != 0 {
		t.Fatalf("拒绝派发却产生请求：%+v %v", records, err)
	}
	maintenance.Store(false)
}

func TestEmbeddingRequestRecoveryKeepsUnknownUsage(t *testing.T) {
	ctx := context.Background()
	s, path := openRuntimeTestStore(t)
	m := &Manager{store: s, deps: Deps{Path: path, Now: s.now, NewID: randomID}}
	for _, maintenance := range []bool{false, true} {
		id := "restart"
		if maintenance {
			id = "maintenance"
		}
		record := EmbeddingRequest{ID: id, ProfileID: "profile-one", ProfileRevision: 1, Purpose: "query", Status: StateRunning, InputBytes: 6, InputDigest: strings.Repeat("a", 64), EstimatedTokens: 262, StartedAt: stamp(s.now())}
		if err := s.write(ctx, "test-record", func(tx *sql.Tx) error { return saveEmbeddingRequest(ctx, tx, record) }); err != nil {
			t.Fatal(err)
		}
		if err := s.write(ctx, "test-recover", func(tx *sql.Tx) error { return m.recoverEmbeddingRequests(ctx, tx, maintenance) }); err != nil {
			t.Fatal(err)
		}
		var raw string
		if err := s.db.QueryRowContext(ctx, "SELECT document FROM wiki_embedding_requests WHERE id=?", id).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal([]byte(raw), &record); err != nil {
			t.Fatal(err)
		}
		code := "panel-restarted"
		if maintenance {
			code = "maintenance-recovery"
		}
		if record.Status != StateInterrupted || record.Usage.TotalTokens != nil || record.Usage.CachedTokens != nil || record.Error == nil || record.Error.Code != code {
			t.Fatalf("恢复没有保留未知用量：%+v", record)
		}
	}
}
