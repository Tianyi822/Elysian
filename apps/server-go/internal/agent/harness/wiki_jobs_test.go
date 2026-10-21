package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
)

func TestWikiExtractionOutboxIsDurableAndIdempotent(t *testing.T) {
	var extractionCalls atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if request.ToolChoice == "propose_wiki_pages" {
			extractionCalls.Add(1)
			if len(request.Tools) != 1 || request.Tools[0].Name != "propose_wiki_pages" || request.MaxTokens > 4096 {
				t.Error("提炼不能获得工具或额外输出预算")
			}
			var input wikiCompileInput
			if err := json.Unmarshal([]byte(request.Messages[1].Content), &input); err != nil || len(input.Evidence) == 0 {
				t.Fatal("原始证据缺失", err)
			}
			args, _ := json.Marshal(map[string]any{"pages": []map[string]any{{"slug": "docker-check", "title": "容器检查", "markdown": "先核验容器状态。", "kind": "runbook", "evidenceIds": []string{input.Evidence[0].ID}}}})
			return model.Response{FinishReason: "tool_calls", ToolCalls: []model.ToolCall{{ID: "wiki", Name: "propose_wiki_pages", Arguments: args}}}, nil
		}
		return finalReply("容器检查完成"), nil
	}, nil)
	space, err := m.CreateWikiSpace(context.Background(), "业务知识", "business")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SetWikiSessionSpace(context.Background(), session.ID, space.ID, false); err != nil {
		t.Fatal(err)
	}
	run := submitAgentTest(t, m, session, "wiki-extract", "容器检查")
	finished := runtimeFinished(t, m, run.ID)
	if finished.Status != StateSucceeded {
		t.Fatalf("主运行失败：%+v", finished)
	}
	for i := 0; i < 2; i++ {
		m.mu.Lock()
		err = m.store.write(context.Background(), "test-outbox-again", func(tx *sql.Tx) error {
			return m.enqueueWikiRunExtraction(context.Background(), tx, &finished, "容器检查完成")
		})
		m.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
	}
	var jobs Page[WikiJob]
	runtimeEventually(t, func() bool {
		jobs, err = m.ListWikiJobs(context.Background(), "", 50)
		return err == nil && len(jobs.Items) == 1 && terminal(jobs.Items[0].Status)
	})
	job := jobs.Items[0]
	if job.Status != StateSucceeded || len(job.CandidateIDs) != 0 || len(job.PublishedRefs) != 1 || extractionCalls.Load() != 1 {
		t.Fatalf("提炼不是至多一次：%+v calls=%d", job, extractionCalls.Load())
	}
	proposals, err := m.ListWikiCandidates(context.Background(), space.ID, "pending")
	if err != nil || len(proposals) != 0 {
		t.Fatalf("候选未落盘：%+v %v", proposals, err)
	}
	pages, err := m.ListWikiPages(context.Background(), space.ID, false)
	if err != nil || len(pages) != 1 || pages[0].Maintenance != "automatic" {
		t.Fatalf("正常提炼未自动发布：%+v %v", pages, err)
	}
	full, err := m.GetWikiJob(context.Background(), job.ID)
	if err != nil || full.Response == nil || full.Input == "" {
		t.Fatalf("提炼请求和响应未保存：%+v %v", full, err)
	}
	raw, _ := json.Marshal(full)
	if strings.Contains(string(raw), "test-only-secret") || strings.Contains(string(raw), `"response"`) || strings.Contains(string(raw), `"input"`) {
		t.Fatalf("公开提炼记录泄露私有字段：%s", raw)
	}
	manual, duplicate, err := m.CreateWikiExtraction(context.Background(), WikiExtractionInput{RequestID: "manual-one", RunID: run.ID})
	if err != nil || duplicate || manual.ID == job.ID || manual.Input != full.Input || manual.Model.Revision != full.Model.Revision {
		t.Fatalf("人工提炼没有沿用独立身份和固定快照：%+v %v", manual, err)
	}
	again, duplicate, err := m.CreateWikiExtraction(context.Background(), WikiExtractionInput{RequestID: "manual-one", RunID: run.ID})
	if err != nil || !duplicate || again.ID != manual.ID {
		t.Fatalf("人工提炼幂等失败：%+v %v", again, err)
	}
	if _, _, err = m.CreateWikiExtraction(context.Background(), WikiExtractionInput{RequestID: "manual-one", WorkflowID: "other-source"}); err == nil {
		t.Fatal("同请求标识不能更换提炼来源")
	}
}

func TestWikiBackgroundRecoveryRetainsResponseAndDoesNotReplay(t *testing.T) {
	s, path := openRuntimeTestStore(t)
	m := &Manager{store: s, deps: Deps{Path: path, Now: s.now, NewID: randomID}}
	response := model.Response{FinishReason: "stop", Content: "已保存的响应"}
	ctx := context.Background()
	for _, kind := range []string{"extraction", "embedding"} {
		job := WikiJob{ID: kind, Kind: kind, OriginKind: "fixture", OriginID: kind, Status: StateRunning, CreatedAt: stamp(s.now()), Input: "固定输入", Response: &response, CandidateIDs: []string{}, Sources: []WikiRef{}}
		if err := s.write(ctx, "test-background-job", func(tx *sql.Tx) error { return saveWikiJob(ctx, tx, job) }); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.recoverWikiJobs(ctx); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"extraction", "embedding"} {
		job, err := readWikiJob(ctx, s.db, kind)
		if err != nil || job.Status != StateInterrupted || job.Response == nil || job.Response.Content != response.Content || job.Input != "固定输入" {
			t.Fatalf("恢复丢失模型事实或自动重试：%+v %v", job, err)
		}
	}
}

func TestWikiBackgroundYieldsToQueuedRun(t *testing.T) {
	s, path := openRuntimeTestStore(t)
	m := &Manager{store: s, ctx: context.Background(), deps: Deps{Path: path, Now: s.now, NewID: randomID}}
	createRuntimeTestRun(t, s, "foreground", runtimeStoreTestTime)
	m.mu.Lock()
	ready := m.wikiBackgroundReadyLocked()
	m.mu.Unlock()
	if ready {
		t.Fatal("有排队的前台 Run 时不应派发后台任务")
	}
}

func TestWikiExtractionFailureKeepsExistingPage(t *testing.T) {
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if request.ToolChoice == "propose_wiki_pages" {
			return model.Response{}, errors.New("fixture-secret")
		}
		return finalReply("检查完成"), nil
	}, nil)
	space, err := m.CreateWikiSpace(context.Background(), "已有记忆", "business")
	if err != nil {
		t.Fatal(err)
	}
	page, err := m.CreateWikiPage(context.Background(), space.ID, WikiPageInput{Slug: "checks", Title: "容器检查", Markdown: "保存的原文"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SetWikiSessionSpace(context.Background(), session.ID, space.ID, false); err != nil {
		t.Fatal(err)
	}
	run := submitAgentTest(t, m, session, "wiki-extract-failure", "容器检查")
	finished := runtimeFinished(t, m, run.ID)
	m.mu.Lock()
	err = m.store.write(context.Background(), "test-failure-outbox", func(tx *sql.Tx) error {
		return m.enqueueWikiRunExtraction(context.Background(), tx, &finished, "检查完成")
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	var jobs Page[WikiJob]
	runtimeEventually(t, func() bool {
		jobs, err = m.ListWikiJobs(context.Background(), "", 50)
		return err == nil && len(jobs.Items) == 1 && terminal(jobs.Items[0].Status)
	})
	if jobs.Items[0].Status != StateFailed || jobs.Items[0].MemoryStatus != "stale" {
		t.Fatalf("失败状态错误：%+v", jobs)
	}
	stored, err := m.GetWikiPage(context.Background(), page.ID)
	if err != nil || stored.Revision != page.Revision || stored.Markdown != page.Markdown {
		t.Fatalf("失败覆盖了旧页：%+v %v", stored, err)
	}
}

func TestEmbeddingIndexSearchRevisionAndCredentialBoundaries(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		if request.Header.Get("Authorization") != "Bearer fixture-embedding-secret" {
			t.Error("未使用固定凭据")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"embedding":[1,0]}]}`))
	}))
	defer server.Close()
	m, _, _ := agentManager(t, func(context.Context, model.Profile, model.Request) (model.Response, error) {
		return finalReply("完成"), nil
	}, func(deps *Deps) { deps.Path = filepath.Join(t.TempDir(), "data", "harness.sqlite") })
	secret := "fixture-embedding-secret"
	profile, err := m.CreateEmbeddingProfile(context.Background(), EmbeddingProfileInput{Name: "本地测试", BaseURL: server.URL, Model: "embedding", Dimensions: 2, Active: true, Credential: &secret})
	if err != nil || profile.Credential != "" || !profile.HasCredential {
		t.Fatalf("公开凭据边界错误：%+v %v", profile, err)
	}
	profile, err = m.UpdateEmbeddingProfile(context.Background(), profile.ID, 1, EmbeddingProfileInput{Name: "更新名称", BaseURL: server.URL, Model: "embedding", Dimensions: 2, Active: true})
	if err != nil || profile.Revision != 2 {
		t.Fatalf("修订更新失败：%+v %v", profile, err)
	}
	info, err := os.Stat(m.embeddingConfigPath())
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("凭据文件权限错误：%v %v", info, err)
	}
	space, err := m.CreateWikiSpace(context.Background(), "搜索知识", "business")
	if err != nil {
		t.Fatal(err)
	}
	page, err := m.CreateWikiPage(context.Background(), space.ID, WikiPageInput{Slug: "restart", Title: "容器重启", Markdown: "先确认服务健康。"})
	if err != nil {
		t.Fatal(err)
	}
	input := WikiIndexInput{RequestID: "rebuild-one", ProfileID: profile.ID, ProfileRevision: profile.Revision}
	job, err := m.RebuildWikiIndex(context.Background(), space.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := m.RebuildWikiIndex(context.Background(), space.ID, input)
	if err != nil || duplicate.ID != job.ID {
		t.Fatal("重复索引请求未回读原任务")
	}
	runtimeEventually(t, func() bool {
		got, e := m.GetWikiJob(context.Background(), job.ID)
		return e == nil && terminal(got.Status)
	})
	result, err := m.SearchWiki(context.Background(), space.ID, "服务恢复", 8)
	if err != nil || result.Degraded || len(result.Items) != 1 || result.Items[0].Method != "hybrid-rrf" {
		t.Fatalf("向量与文本未合并：%+v %v", result, err)
	}
	if _, err = m.UpdateWikiPage(context.Background(), page.ID, WikiPageInput{ExpectedRevision: page.Revision, Slug: page.Slug, Title: "容器重启", Markdown: "更新后的内容"}); err != nil {
		t.Fatal(err)
	}
	before := calls.Load()
	result, err = m.SearchWiki(context.Background(), space.ID, "容器重启", 8)
	if err != nil || !result.Degraded || len(result.Items) != 1 || calls.Load() != before {
		t.Fatalf("旧索引不应参与新修订检索：%+v %v", result, err)
	}
}

func TestWikiChineseBigramsDoNotMatchUnrelatedCharacters(t *testing.T) {
	if wikiTextScore("容器重启", "重启容器前先检查") == 0 {
		t.Fatal("中文双字查询丢失词序匹配")
	}
	if wikiTextScore("容器", "内容与机器") != 0 {
		t.Fatal("中文检索不应仅因共享单字而匹配")
	}
	if wikiTextScore("redis", "redirect") != 0 {
		t.Fatal("英文检索必须保留完整词")
	}
}

func TestEmbeddingRedirectDoesNotForwardCredential(t *testing.T) {
	var forwarded atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { forwarded.Add(1) }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		http.Redirect(w, req, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	_, _, err := embeddingCompleteHTTP(context.Background(), EmbeddingProfile{BaseURL: source.URL, Model: "embedding", Dimensions: 2, Credential: "fixture-secret"}, "内容")
	if err == nil || forwarded.Load() != 0 {
		t.Fatalf("凭据被转发到跳转地址：%v %d", err, forwarded.Load())
	}
}

func TestWikiHybridQueryAllowsWithdrawalWhileProviderWaits(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		close(entered)
		select {
		case <-release:
		case <-request.Context().Done():
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"embedding":[1,0]}]}`))
	}))
	defer server.Close()
	defer close(release)
	m, _, _ := agentManager(t, func(context.Context, model.Profile, model.Request) (model.Response, error) {
		return finalReply("完成"), nil
	}, func(deps *Deps) { deps.Path = filepath.Join(t.TempDir(), "data", "harness.sqlite") })
	profile, err := m.CreateEmbeddingProfile(context.Background(), EmbeddingProfileInput{Name: "阻塞测试", BaseURL: server.URL, Model: "embedding", Dimensions: 2, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	space, err := m.CreateWikiSpace(context.Background(), "撤回知识", "business")
	if err != nil {
		t.Fatal(err)
	}
	page, err := m.CreateWikiPage(context.Background(), space.ID, WikiPageInput{Slug: "withdraw", Title: "容器重启", Markdown: "检查健康"})
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	err = m.store.write(context.Background(), "test-index-ready", func(tx *sql.Tx) error {
		_, err := tx.Exec("INSERT INTO wiki_embedding_indexes(page_id,page_revision,digest,profile_id,profile_revision,vector,created_at) VALUES(?,?,?,?,?,?,?)", page.ID, page.Revision, page.Digest, profile.ID, profile.Revision, "[1,0]", wikiNow(m))
		return err
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	queryDone := make(chan WikiSearchResult, 1)
	go func() {
		result, _ := m.SearchWiki(context.Background(), space.ID, "容器重启", 8)
		queryDone <- result
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("向量查询未开始")
	}
	withdrawn := make(chan error, 1)
	go func() { _, err := m.WithdrawWikiPage(context.Background(), page.ID, page.Revision); withdrawn <- err }()
	select {
	case err := <-withdrawn:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("等待向量供应商时阻塞了撤回")
	}
	// 供应商等到请求时限再退出，期间撤回已经完成；返回不能泄漏撤回页。
	select {
	case result := <-queryDone:
		if len(result.Items) != 0 {
			t.Fatalf("撤回后仍返回旧页面：%+v", result)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("向量请求没有有界结束")
	}
}
