package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
)

func TestWikiNewSessionDefaultAndOldSelectionPreserved(t *testing.T) {
	m, profile := sessionAPIManager(t)
	ctx := context.Background()
	first, err := m.CreateSession(ctx, CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision})
	if err != nil {
		t.Fatal(err)
	}
	selection, err := m.WikiSessionSelection(ctx, first.ID)
	if err != nil || selection.SpaceID != "" || selection.IncludeGlobal {
		t.Fatalf("新会话不应绑定知识空间：%+v %v", selection, err)
	}
	second, err := m.CreateSession(ctx, CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision})
	if err != nil {
		t.Fatal(err)
	}
	other, _ := m.WikiSessionSelection(ctx, second.ID)
	if other.SpaceID != selection.SpaceID {
		t.Fatal("新会话创建了不同全局空间")
	}
	business, err := m.CreateWikiSpace(ctx, "旧会话业务", "business")
	if err != nil {
		t.Fatal(err)
	}
	_, err = m.SetWikiSessionSpace(ctx, first.ID, business.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	// 模拟持久化旧会话；后续接受运行不依赖其新会话标记，也不改写选中空间。
	err = m.store.write(ctx, "old-session-fixture", func(tx *sql.Tx) error {
		s, e := readSession(ctx, tx, first.ID)
		if e != nil {
			return e
		}
		s.WikiStrategy = ""
		return saveSession(ctx, tx, s)
	})
	if err != nil {
		t.Fatal(err)
	}
	run, _, err := m.CreateTask(ctx, first.ID, AgentInput{RequestID: "old-session-new-run", Content: "查询知识"})
	if err != nil {
		t.Fatal(err)
	}
	assertDisabled := func(run Run) {
		t.Helper()
		if run.WikiStrategy != wikiDisabledStrategy {
			t.Fatal("新运行没有关闭长期记忆")
		}
		for _, capability := range run.Snapshot.Tools {
			if capability.Source == "wiki" {
				t.Fatalf("新运行仍提供知识工具: %s", capability.Name)
			}
		}
		var snapshots int
		if err := m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM wiki_run_spaces WHERE run_id=?", run.ID).Scan(&snapshots); err != nil || snapshots != 0 {
			t.Fatalf("新运行仍固定旧空间: %d %v", snapshots, err)
		}
	}
	assertDisabled(run)
	selected, _ := m.WikiSessionSelection(ctx, first.ID)
	if selected.SpaceID != business.ID || !selected.IncludeGlobal {
		t.Fatalf("旧会话选择被改写：%+v", selected)
	}
	finishSessionTestRun(t, m.store, run.ID, "完成", nil)
	continuation, _, err := m.ContinueTask(ctx, run.TaskID, AgentInput{RequestID: "old-session-continue", Content: "继续"})
	if err != nil {
		t.Fatal(err)
	}
	assertDisabled(continuation)
	finishSessionTestRun(t, m.store, continuation.ID, "完成", nil)
	messages, err := m.Messages(ctx, first.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	var lastUser string
	for _, message := range messages.Items {
		if message.Role == "user" {
			lastUser = message.ID
		}
	}
	edited, _, err := m.ContinueTask(ctx, continuation.TaskID, AgentInput{RequestID: "memory-disabled-edit", Content: "编辑后再发送", ReplaceMessageID: lastUser})
	if err != nil {
		t.Fatal(err)
	}
	assertDisabled(edited)
}

func TestWikiNavigationAndAcceptedLegacyKeepDifferentContracts(t *testing.T) {
	m, profile := sessionAPIManager(t)
	ctx := context.Background()
	s, err := m.CreateSession(ctx, CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision})
	if err != nil {
		t.Fatal(err)
	}
	space, err := m.CreateWikiSpace(ctx, "存量知识", "business")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SetWikiSessionSpace(ctx, s.ID, space.ID, false); err != nil {
		t.Fatal(err)
	}
	page, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "test", Title: "容器知识", Markdown: "此正文必须按需读取"})
	if err != nil {
		t.Fatal(err)
	}
	run, _, err := m.CreateTask(ctx, s.ID, AgentInput{RequestID: "navigation-contract", Content: "容器知识"})
	if err != nil {
		t.Fatal(err)
	}
	if run.WikiStrategy != wikiDisabledStrategy {
		t.Fatal("新运行未关闭知识记忆")
	}
	a := &agentExecution{manager: m, run: run}
	messages, refs, err := a.wikiRecallLocked(ctx)
	if err != nil || len(messages) != 0 || len(refs) != 0 {
		t.Fatalf("新运行仍召回: %+v %+v %v", messages, refs, err)
	}
	// 恢复固定的存量导航快照，保留按需读取与旧版本兼容。
	run.WikiStrategy = wikiNavigationStrategy
	run.Snapshot.Tools = wikiNavigationCapabilities()
	if err := m.store.write(ctx, "legacy-wiki-fixture", func(tx *sql.Tx) error { return snapshotWikiRunSpaces(ctx, tx, run.ID, s.ID) }); err != nil {
		t.Fatal(err)
	}
	a.run = run

	m.mu.Lock()
	messages, refs, err = a.wikiRecallLocked(ctx)
	m.mu.Unlock()
	if err != nil || len(messages) != 1 || len(refs) != 1 || strings.Contains(messages[0].Content, page.Markdown) {
		t.Fatalf("导航注入正文或缺来源：%+v %+v %v", messages, refs, err)
	}
	var modernRead Capability
	for _, c := range run.Snapshot.Tools {
		if c.Name == "wiki_read" {
			modernRead = c
		}
	}
	if !strings.Contains(string(modernRead.Parameters), "offset") {
		t.Fatal("新运行没有分页读取契约")
	}
	out, err := m.executeWikiNavigation(ctx, run, Operation{ID: "navigation-read", Capability: modernRead, ArgumentsJSON: `{"pageId":"` + page.ID + `","limit":6}`})
	if err != nil {
		t.Fatal(err)
	}
	var read WikiPageRead
	if err = json.Unmarshal(out.Value, &read); err != nil || read.NextOffset == nil || *read.NextOffset != 6 {
		t.Fatalf("分页无进展：%+v %v", read, err)
	}
	// 已接受旧运行的无标记快照保留旧召回及工具参数，不迁移。
	legacy := run
	legacy.WikiStrategy = ""
	legacy.Snapshot.Tools = wikiCapabilities()
	a.run = legacy
	m.mu.Lock()
	messages, _, err = a.wikiRecallLocked(ctx)
	m.mu.Unlock()
	if err != nil || len(messages) != 1 || !strings.Contains(messages[0].Content, page.Markdown) {
		t.Fatalf("旧运行召回行为被改写：%+v %v", messages, err)
	}
	if strings.Contains(string(legacy.Snapshot.Tools[1].Parameters), "offset") {
		t.Fatal("旧运行工具快照被改写")
	}
}

func TestWikiReadUTF8AlwaysMakesProgress(t *testing.T) {
	p := WikiPage{Markdown: "甲乙"}
	if _, err := wikiReadSlice(p, 0, 1); err == nil {
		t.Fatal("不能返回永不前进的 UTF-8 分页")
	}
	read, err := wikiReadSlice(p, 0, 4)
	if err != nil || read.Markdown != "甲" || read.NextOffset == nil || *read.NextOffset != 3 {
		t.Fatalf("分页错误：%+v %v", read, err)
	}
	if _, err := wikiReadSlice(p, 1, 4); err == nil {
		t.Fatal("不能从 UTF-8 字符中间读取")
	}
}
