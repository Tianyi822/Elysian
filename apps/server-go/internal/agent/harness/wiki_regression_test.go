package harness

import (
	"context"
	"database/sql"
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/workspace"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func wikiTestManager(t *testing.T) (*Manager, Session) {
	t.Helper()
	m, s, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		if r.ToolChoice == "propose_wiki_pages" {
			return model.Response{}, errors.New("测试服务不提炼")
		}
		return finalReply("检查已完成"), nil
	}, nil)
	return m, s
}

func TestWikiCandidateDecisionAtomicAndIdempotent(t *testing.T) {
	m, _ := wikiTestManager(t)
	ctx := context.Background()
	space, err := m.CreateWikiSpace(ctx, "业务", "business")
	if err != nil {
		t.Fatal(err)
	}
	proposals, err := m.ImportWiki(ctx, space.ID, map[string]string{"runbook.md": "# 运行手册\n\n核对证据后处理。"})
	if err != nil {
		t.Fatal(err)
	}
	fail := errors.New("事务失败")
	m.mu.Lock()
	m.store.beforeWrite = func(op string) error {
		if op == "wiki-candidate-decision" {
			return fail
		}
		return nil
	}
	m.mu.Unlock()
	if _, err = m.DecideWikiCandidate(ctx, proposals[0].ID, "approved"); err == nil {
		t.Fatal("故障没有阻断发布")
	}
	m.mu.Lock()
	m.store.beforeWrite = nil
	m.mu.Unlock()
	pages, err := m.ListWikiPages(ctx, space.ID, false)
	if err != nil || len(pages) != 0 {
		t.Fatalf("失败发布留下半成品: %v %v", pages, err)
	}
	approved, err := m.DecideWikiCandidate(ctx, proposals[0].ID, "approved")
	if err != nil {
		t.Fatal(err)
	}
	again, err := m.DecideWikiCandidate(ctx, proposals[0].ID, "approved")
	if err != nil || again.PageID != approved.PageID {
		t.Fatalf("重复决定不幂等: %v", err)
	}
	if _, err = m.DecideWikiCandidate(ctx, proposals[0].ID, "rejected"); err == nil {
		t.Fatal("相反决定必须冲突")
	}
	pages, _ = m.ListWikiPages(ctx, space.ID, false)
	if len(pages) != 1 {
		t.Fatal("重复发布页面")
	}
	export, err := m.ExportWiki(ctx, space.ID)
	if err != nil || !strings.Contains(export.Files["index.md"], approved.PageID) || export.Files["sources.json"] == "" || export.Files["changelog.md"] == "" {
		t.Fatalf("导出缺少稳定索引/依据: %v", err)
	}
}

func TestWikiAcceptedRevisionAndWithdrawalIsolation(t *testing.T) {
	m, s := wikiTestManager(t)
	ctx := context.Background()
	space, err := m.CreateWikiSpace(ctx, "业务", "business")
	if err != nil {
		t.Fatal(err)
	}
	page, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "docker", Title: "容器检查", Markdown: "原始知识"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SetWikiSessionSpace(ctx, s.ID, space.ID, false); err != nil {
		t.Fatal(err)
	}
	run := submitAgentTest(t, m, s, "wiki-revision", "容器检查")
	finished := runtimeFinished(t, m, run.ID)
	if finished.Status != StateSucceeded {
		t.Fatalf("%+v", finished)
	}
	quoted, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "quoted", Title: "派生总结", Markdown: "人工引用成功答复", Evidence: []WikiEvidence{{Kind: "run", RunID: run.ID, Text: "检查已完成"}}})
	if err != nil || len(quoted.Sources) != 1 || quoted.Sources[0].PageID != page.ID {
		t.Fatalf("引用运行未自动传递来源: %+v %v", quoted, err)
	}
	next, err := m.UpdateWikiPage(ctx, page.ID, WikiPageInput{ExpectedRevision: 1, Slug: page.Slug, Title: page.Title, Markdown: "新的知识"})
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	var revision int
	err = m.store.db.QueryRow("SELECT revision FROM wiki_visible_pages WHERE owner_kind='run' AND owner_id=? AND page_id=?", run.ID, page.ID).Scan(&revision)
	m.mu.Unlock()
	if err != nil || revision != 1 {
		t.Fatalf("普通修订改变了已接受快照: %d %v", revision, err)
	}
	if _, err = m.WithdrawWikiPage(ctx, page.ID, next.Revision); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	invalid, err := wikiArtifactInvalid(ctx, m.store.db, "run", run.ID)
	m.mu.Unlock()
	if err != nil || !invalid {
		t.Fatalf("撤回未隔离派生运行: %v", err)
	}
	hits, err := m.SearchWiki(ctx, space.ID, "容器检查", 8)
	if err != nil || len(hits.Items) != 0 {
		t.Fatal("撤回页面仍被召回")
	}
	old, err := m.Get(ctx, run.ID)
	if err != nil || old.Status != StateSucceeded {
		t.Fatal("撤回改写历史终态")
	}
}

func TestWikiEvidenceSurvivesWholeSessionCleanup(t *testing.T) {
	m, s := wikiTestManager(t)
	ctx := context.Background()
	run := submitAgentTest(t, m, s, "wiki-evidence", "容器检查")
	finished := runtimeFinished(t, m, run.ID)
	if finished.Status != StateSucceeded {
		t.Fatalf("%+v", finished)
	}
	space, err := m.CreateWikiSpace(ctx, "业务", "business")
	if err != nil {
		t.Fatal(err)
	}
	page, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "result", Title: "已验证经验", Markdown: "留存摘录", Evidence: []WikiEvidence{{Kind: "run", RunID: run.ID, EventSeq: finished.LastSeq, Text: "检查已完成"}}})
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	err = m.store.write(ctx, "test-old-session", func(tx *sql.Tx) error {
		session, e := readSession(ctx, tx, s.ID)
		if e != nil {
			return e
		}
		session.LastActivityAt = stamp(m.deps.Now().Add(-31 * 24 * time.Hour))
		return saveSession(ctx, tx, session)
	})
	if err == nil {
		err = m.sweep(ctx)
	}
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	got, err := m.GetWikiPage(ctx, page.ID)
	if err != nil || len(got.Evidence) != 1 || !got.Evidence[0].OriginalCleared || got.Evidence[0].Text != "检查已完成" {
		raw, _ := json.Marshal(got)
		t.Fatalf("清理丢失证据: %s %v", raw, err)
	}
}

func TestWikiWithdrawalQuarantinesDerivedPagesAfterSourceSessionCleanup(t *testing.T) {
	m, s := wikiTestManager(t)
	ctx := context.Background()
	space, err := m.CreateWikiSpace(ctx, "业务", "business")
	if err != nil {
		t.Fatal(err)
	}
	source, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "source", Title: "容器检查", Markdown: "核对容器状态"})
	if err != nil {
		t.Fatal(err)
	}
	derived, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "derived", Title: "容器检查经验", Markdown: "来自检查资料的总结", Sources: []WikiRef{{source.ID, source.Revision, source.Digest}}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = m.SetWikiSessionSpace(ctx, s.ID, space.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	r := submitAgentTest(t, m, s, "wiki-source-cleanup", "容器检查")
	if done := runtimeFinished(t, m, r.ID); done.Status != StateSucceeded {
		t.Fatalf("%+v", done)
	}
	m.mu.Lock()
	err = m.store.write(ctx, "test-old-session", func(tx *sql.Tx) error {
		session, e := readSession(ctx, tx, s.ID)
		if e != nil {
			return e
		}
		session.LastActivityAt = stamp(m.deps.Now().Add(-31 * 24 * time.Hour))
		return saveSession(ctx, tx, session)
	})
	if err == nil {
		err = m.sweep(ctx)
	}
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.WithdrawWikiPage(ctx, source.ID, source.Revision); err != nil {
		t.Fatal(err)
	}
	hits, err := m.SearchWiki(ctx, space.ID, "容器检查", 8)
	if err != nil || len(hits.Items) != 0 {
		t.Fatalf("撤回后仍召回派生知识: %+v %v", hits, err)
	}
	retained, err := m.GetWikiPage(ctx, derived.ID)
	if err != nil || retained.Markdown != derived.Markdown {
		t.Fatal("隔离不得删除历史正文", err)
	}
	if _, err = m.WithdrawWikiPage(ctx, derived.ID, derived.Revision); err != nil {
		t.Fatal("派生页面隔离后仍应允许人工撤回", err)
	}
}

func TestWikiFullTextChineseTagsAndAliases(t *testing.T) {
	m, _ := wikiTestManager(t)
	ctx := context.Background()
	space, err := m.CreateWikiSpace(ctx, "业务", "business")
	if err != nil {
		t.Fatal(err)
	}
	p, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "redis-prod", Title: "缓存维护", Markdown: "数据库连接池耗尽时先核对活动事务", Tags: []string{"redis_prod"}, Aliases: []string{"生产缓存"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"连接池", "redis_prod", "生产缓存"} {
		hits, err := m.SearchWiki(ctx, space.ID, query, 8)
		if err != nil || len(hits.Items) != 1 || hits.Items[0].Page.ID != p.ID {
			t.Fatalf("%s: %+v %v", query, hits, err)
		}
	}
	if _, err := m.SearchWiki(ctx, space.ID, `" OR *`, 8); err != nil {
		t.Fatal("搜索词不能被当作 FTS 表达式", err)
	}
}

func TestWikiNavigationDoesNotInjectLargeBody(t *testing.T) {
	m, session := wikiTestManager(t)
	ctx := context.Background()
	// 容量按 token 记：页面正文约 7.5k token 加固定上下文后必须装不下，fixture 才能验证裁剪。
	profile, err := m.deps.Profiles.Update(session.ModelProfileID, 1, model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, BaseURL: "http://127.0.0.1:9/v1", Model: "test", ContextTokens: 14000, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "test"}, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SwitchSessionModel(ctx, session.ID, SwitchModelInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision}); err != nil {
		t.Fatal(err)
	}
	space, err := m.CreateWikiSpace(ctx, "业务", "business")
	if err != nil {
		t.Fatal(err)
	}
	page, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "large", Title: "容器检查", Markdown: strings.Repeat("大", 5000)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SetWikiSessionSpace(ctx, session.ID, space.ID, false); err != nil {
		t.Fatal(err)
	}
	r := submitAgentTest(t, m, session, "wiki-trim", "容器检查")
	if done := runtimeFinished(t, m, r.ID); done.Status != StateSucceeded {
		t.Fatalf("%+v", done)
	}
	m.mu.Lock()
	refs, err := wikiArtifactRefs(ctx, m.store.db, "run", r.ID)
	m.mu.Unlock()
	if err != nil || len(refs) != 1 || refs[0].PageID != page.ID {
		t.Fatalf("导航标题来源没有固定: %+v %v", refs, err)
	}
	if _, err = m.WithdrawWikiPage(ctx, page.ID, page.Revision); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	invalid, err := wikiArtifactInvalid(ctx, m.store.db, "run", r.ID)
	m.mu.Unlock()
	if err != nil || !invalid {
		t.Fatalf("导航来源撤回应隔离 Run: %v", err)
	}
}

func TestWikiWorkspaceQuarantinePersistsUntilEmpty(t *testing.T) {
	files, err := workspace.Open(filepath.Join(t.TempDir(), "files"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		return finalReply("检查已完成"), nil
	}, func(d *Deps) { d.Workspaces = files })
	ctx := context.Background()
	r := submitAgentTest(t, m, session, "workspace-wiki", "检查")
	runtimeFinished(t, m, r.ID)
	space, err := m.CreateWikiSpace(ctx, "业务", "business")
	if err != nil {
		t.Fatal(err)
	}
	page, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "source", Title: "文件依据", Markdown: "工作文件的来源"})
	if err != nil {
		t.Fatal(err)
	}
	v, err := m.WriteWorkspace(ctx, r.TaskID, 0, "result.txt", strings.NewReader("原始文件"))
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	err = m.store.write(ctx, "workspace-source-fixture", func(tx *sql.Tx) error {
		return saveWikiArtifact(ctx, tx, "workspace", workspaceWikiKey(v), r.TaskID, r.ID, 0, []WikiRef{{page.ID, page.Revision, page.Digest}})
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.WithdrawWikiPage(ctx, page.ID, page.Revision); err != nil {
		t.Fatal(err)
	}
	view, err := m.Workspace(ctx, r.TaskID, "result.txt")
	if err != nil || !view.Quarantined || string(view.Content) != "原始文件" {
		t.Fatalf("历史文件未隔离保留: %+v %v", view, err)
	}
	m.mu.Lock()
	err = m.inheritWorkspaceWikiLocked(ctx, r, v)
	m.mu.Unlock()
	requireWorkspaceCode(t, err, "wiki-workspace-quarantined")
	v, err = m.WriteWorkspace(ctx, r.TaskID, v.Revision, "result.txt", strings.NewReader("人工覆盖"))
	if err != nil {
		t.Fatal(err)
	}
	view, err = m.Workspace(ctx, r.TaskID, "")
	if err != nil || !view.Quarantined {
		t.Fatal("单文件覆盖不应暗中解除隔离", err)
	}
	v, err = m.DeleteWorkspace(ctx, r.TaskID, v.Revision, "result.txt")
	if err != nil {
		t.Fatal(err)
	}
	view, err = m.Workspace(ctx, r.TaskID, "")
	if err != nil || view.Quarantined || v.FileCount != 0 {
		t.Fatal("空工作区仍继承旧来源", err)
	}
}
