package harness

import (
	"context"
	"database/sql"
	"elysian/server/internal/agent/harness/model"
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
	if err != nil || selection.SpaceID == "" || selection.IncludeGlobal {
		t.Fatalf("未默认选中唯一全局空间：%+v %v", selection, err)
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
	if run.WikiStrategy != wikiNavigationStrategy {
		t.Fatal("旧会话新运行没有固定新策略")
	}
	selected, _ := m.WikiSessionSelection(ctx, first.ID)
	if selected.SpaceID != business.ID || !selected.IncludeGlobal {
		t.Fatalf("旧会话选择被改写：%+v", selected)
	}
	finishSessionTestRun(t, m.store, run.ID, "完成", nil)
	continuation, _, err := m.ContinueTask(ctx, run.TaskID, AgentInput{RequestID: "old-session-continue", Content: "继续"})
	if err != nil {
		t.Fatal(err)
	}
	if continuation.WikiStrategy != wikiNavigationStrategy {
		t.Fatal("续轮没有固定新策略")
	}
}

func TestWikiNavigationAndAcceptedLegacyKeepDifferentContracts(t *testing.T) {
	m, profile := sessionAPIManager(t)
	ctx := context.Background()
	s, err := m.CreateSession(ctx, CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision})
	if err != nil {
		t.Fatal(err)
	}
	selection, _ := m.WikiSessionSelection(ctx, s.ID)
	page, err := m.CreateWikiPage(ctx, selection.SpaceID, WikiPageInput{Slug: "test", Title: "容器知识", Markdown: "此正文必须按需读取"})
	if err != nil {
		t.Fatal(err)
	}
	run, _, err := m.CreateTask(ctx, s.ID, AgentInput{RequestID: "navigation-contract", Content: "容器知识"})
	if err != nil {
		t.Fatal(err)
	}
	a := &agentExecution{manager: m, run: run}
	m.mu.Lock()
	messages, refs, err := a.wikiRecallLocked(ctx)
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

func TestWikiCompilationRejectsForgedEvidence(t *testing.T) {
	m, profile := sessionAPIManager(t)
	ctx := context.Background()
	s, err := m.CreateSession(ctx, CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision})
	if err != nil {
		t.Fatal(err)
	}
	selected, _ := m.WikiSessionSelection(ctx, s.ID)
	job := WikiJob{Strategy: wikiNavigationStrategy, SpaceID: selected.SpaceID, Input: `{"evidence":[{"id":"real","kind":"user","text":"原始事实"}],"existingPages":[]}`}
	job.Response = wikiCompileTestResponse(`{"pages":[{"slug":"forged","title":"伪造知识","markdown":"伪造","kind":"reference","evidenceIds":["forged"]}]}`)
	if err = m.publishWikiCompilation(ctx, &job); err == nil {
		t.Fatal("伪造证据标识被发布")
	}
	pages, err := m.ListWikiPages(ctx, selected.SpaceID, false)
	if err != nil || len(pages) != 0 {
		t.Fatal("无效编译留下了页面", err)
	}
}

func wikiCompileTestResponse(args string) *model.Response {
	return &model.Response{FinishReason: "tool_calls", ToolCalls: []model.ToolCall{{Name: "propose_wiki_pages", Arguments: json.RawMessage(args)}}}
}

func TestWikiSourceImportIdempotenceCompilationAndImmutableOriginal(t *testing.T) {
	m, profile := sessionAPIManager(t)
	ctx := context.Background()
	s, err := m.CreateSession(ctx, CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision})
	if err != nil {
		t.Fatal(err)
	}
	selected, _ := m.WikiSessionSelection(ctx, s.ID)
	in := WikiSourceInput{RequestID: "source-one", Title: "生产约定", Filename: "rules.md", Text: "所有生产更新都先检查健康状态。", ModelProfileID: profile.ID, ModelProfileRevision: profile.Revision}
	result, duplicate, err := m.CreateWikiSource(ctx, selected.SpaceID, in)
	if err != nil || duplicate {
		t.Fatalf("导入失败：%+v %v", result, err)
	}
	again, duplicate, err := m.CreateWikiSource(ctx, selected.SpaceID, in)
	if err != nil || !duplicate || again.Source.ID != result.Source.ID || again.Job.ID != result.Job.ID {
		t.Fatalf("导入重复：%+v %v", again, err)
	}
	changed := in
	changed.Text = "被更改的原文"
	if _, _, err = m.CreateWikiSource(ctx, selected.SpaceID, changed); err == nil {
		t.Fatal("重复请求允许替换原文")
	}
	if _, err = m.UpdateWikiPage(ctx, result.Source.ID, WikiPageInput{ExpectedRevision: 1, Slug: result.Source.Slug, Title: result.Source.Title, Markdown: "改写", Kind: "sources"}); err == nil {
		t.Fatal("导入原文允许改写")
	}
	var input wikiCompileInput
	if err = json.Unmarshal([]byte(result.Job.Input), &input); err != nil || len(input.Evidence) != 1 || input.Evidence[0].Text != in.Text {
		t.Fatal("未保存可核验原始证据", err)
	}
	args, _ := json.Marshal(map[string]any{"pages": []map[string]any{{"slug": "production-check", "title": "生产更新检查", "markdown": in.Text, "kind": "convention", "evidenceIds": []string{input.Evidence[0].ID}}}})
	job := result.Job
	job.Response = wikiCompileTestResponse(string(args))
	job.Status = StateSucceeded
	if err = m.publishWikiCompilation(ctx, &job); err != nil || len(job.PublishedRefs) != 1 || job.MemoryStatus != "updated" {
		t.Fatalf("原文编译未发布：%+v %v", job, err)
	}
	derived, err := m.GetWikiPage(ctx, job.PublishedRefs[0].PageID)
	if err != nil || len(derived.Evidence) != 1 || len(derived.Sources) != 1 || derived.Sources[0].PageID != result.Source.ID {
		t.Fatalf("编译来源未固定：%+v %v", derived, err)
	}
	if _, err = m.WithdrawWikiPage(ctx, result.Source.ID, 1); err != nil {
		t.Fatal(err)
	}
	found, err := m.SearchWiki(ctx, selected.SpaceID, "生产更新", 8)
	if err != nil || len(found.Items) != 0 {
		t.Fatalf("原文撤回未隔离派生页：%+v %v", found, err)
	}
}

func TestWikiCompilationConflictAndCASRemainPending(t *testing.T) {
	for _, reason := range []string{"semantic-conflict", "revision-conflict", "manual-protection"} {
		t.Run(reason, func(t *testing.T) {
			m, profile := sessionAPIManager(t)
			ctx := context.Background()
			s, err := m.CreateSession(ctx, CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision})
			if err != nil {
				t.Fatal(err)
			}
			selected, _ := m.WikiSessionSelection(ctx, s.ID)
			mode := "automatic"
			if reason == "manual-protection" {
				mode = "manual"
			}
			page, err := m.CreateWikiPage(ctx, selected.SpaceID, WikiPageInput{Slug: "checks", Title: "生产检查", Markdown: "原有知识", Maintenance: mode})
			if err != nil {
				t.Fatal(err)
			}
			imported, _, err := m.CreateWikiSource(ctx, selected.SpaceID, WikiSourceInput{RequestID: "conflict-source", Title: "生产检查资料", Text: "生产检查必须核验。", ModelProfileID: profile.ID, ModelProfileRevision: profile.Revision})
			if err != nil {
				t.Fatal(err)
			}
			var input wikiCompileInput
			if err = json.Unmarshal([]byte(imported.Job.Input), &input); err != nil || len(input.ExistingPages) != 1 {
				t.Fatalf("提炼前未搜索同空间相关页：%+v %v", input, err)
			}
			if reason == "revision-conflict" {
				if _, err = m.UpdateWikiPage(ctx, page.ID, WikiPageInput{ExpectedRevision: 1, Slug: page.Slug, Title: page.Title, Markdown: "并发新版", Maintenance: "automatic"}); err != nil {
					t.Fatal(err)
				}
			}
			args, _ := json.Marshal(map[string]any{"pages": []map[string]any{{"pageId": page.ID, "expectedRevision": 1, "slug": page.Slug, "title": page.Title, "markdown": "提议新版", "kind": "convention", "conflict": reason == "semantic-conflict", "evidenceIds": []string{input.Evidence[0].ID}}}})
			job := imported.Job
			job.Response = wikiCompileTestResponse(string(args))
			job.Status = StateSucceeded
			if err = m.publishWikiCompilation(ctx, &job); err != nil || len(job.PublishedRefs) != 0 || len(job.CandidateIDs) != 1 || job.MemoryStatus != "unchanged" {
				t.Fatalf("冲突未保留候选：%+v %v", job, err)
			}
			proposals, err := m.ListWikiCandidates(ctx, selected.SpaceID, "pending")
			if err != nil || len(proposals) != 1 || proposals[0].Reason != reason {
				t.Fatalf("候选理由丢失：%+v %v", proposals, err)
			}
			current, _ := m.GetWikiPage(ctx, page.ID)
			if current.Markdown == "提议新版" {
				t.Fatal("冲突覆盖已有页")
			}
			if proposals[0].CurrentPage == nil || proposals[0].CurrentPage.Revision != current.Revision || proposals[0].CurrentPage.Markdown != current.Markdown {
				t.Fatal("候选没有提供所需复核的当前版本")
			}
			if reason == "revision-conflict" {
				if _, err = m.DecideWikiCandidate(ctx, proposals[0].ID, "approved"); err == nil {
					t.Fatal("旧请求静默重置了版本基准")
				}
			}
			if _, err = m.DecideWikiCandidate(ctx, proposals[0].ID, "approved", -1); err == nil {
				t.Fatal("接受了负修订")
			}
			accepted, err := m.DecideWikiCandidate(ctx, proposals[0].ID, "approved", current.Revision)
			if err != nil || accepted.Status != "approved" || accepted.PageID != page.ID {
				t.Fatalf("审阅当前版本后仍无法采纳：%+v %v", accepted, err)
			}
			published, err := m.GetWikiPage(ctx, page.ID)
			if err != nil || published.Revision != current.Revision+1 || published.Markdown != "提议新版" || published.Maintenance != "manual" {
				t.Fatalf("人工采纳未发布正确修订：%+v %v", published, err)
			}
		})
	}
}

func TestWikiSlugConflictCanBeReviewedButCannotReviveWithdrawnPage(t *testing.T) {
	for _, scenario := range []string{"approved", "target-withdrawn", "source-withdrawn"} {
		m, profile := sessionAPIManager(t)
		ctx := context.Background()
		s, err := m.CreateSession(ctx, CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision})
		if err != nil {
			t.Fatal(err)
		}
		selection, _ := m.WikiSessionSelection(ctx, s.ID)
		imported, _, err := m.CreateWikiSource(ctx, selection.SpaceID, WikiSourceInput{RequestID: "slug-race", Title: "生产资料", Text: "必须检查健康状态。", ModelProfileID: profile.ID, ModelProfileRevision: profile.Revision})
		if err != nil {
			t.Fatal(err)
		}
		page, err := m.CreateWikiPage(ctx, selection.SpaceID, WikiPageInput{Slug: "concurrent", Title: "并发页面", Markdown: "并发保存的知识"})
		if err != nil {
			t.Fatal(err)
		}
		var input wikiCompileInput
		if err = json.Unmarshal([]byte(imported.Job.Input), &input); err != nil {
			t.Fatal(err)
		}
		args, _ := json.Marshal(map[string]any{"pages": []map[string]any{{"slug": page.Slug, "title": "建议合并", "markdown": "必须检查健康状态。", "kind": "convention", "evidenceIds": []string{input.Evidence[0].ID}}}})
		job := imported.Job
		job.Response = wikiCompileTestResponse(string(args))
		if err = m.publishWikiCompilation(ctx, &job); err != nil || len(job.CandidateIDs) != 1 {
			t.Fatalf("slug 竞争未保存候选：%+v %v", job, err)
		}
		proposals, err := m.ListWikiCandidates(ctx, selection.SpaceID, "pending")
		if err != nil || len(proposals) != 1 || proposals[0].PageID != page.ID || proposals[0].CurrentPage == nil {
			t.Fatalf("竞争没有固定具体页面：%+v %v", proposals, err)
		}
		if _, err = m.DecideWikiCandidate(ctx, proposals[0].ID, "approved"); err == nil {
			t.Fatal("新页竞争绕过人工版本复核")
		}
		if scenario == "target-withdrawn" {
			current, err := m.WithdrawWikiPage(ctx, page.ID, page.Revision)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = m.DecideWikiCandidate(ctx, proposals[0].ID, "approved", current.Revision); err == nil {
				t.Fatal("候选复活了撤回页")
			}
		} else if scenario == "source-withdrawn" {
			if _, err = m.WithdrawWikiPage(ctx, imported.Source.ID, 1); err != nil {
				t.Fatal(err)
			}
			if _, err = m.DecideWikiCandidate(ctx, proposals[0].ID, "approved", page.Revision); err == nil {
				t.Fatal("来源撤回后仍可采纳")
			}
			invalidated, err := m.ListWikiCandidates(ctx, selection.SpaceID, "invalidated")
			if err != nil || len(invalidated) != 1 {
				t.Fatalf("来源撤回未终结候选：%+v %v", invalidated, err)
			}
			published, err := m.GetWikiPage(ctx, page.ID)
			if err != nil || published.Revision != 1 || published.Markdown != page.Markdown {
				t.Fatalf("无效候选改变了页面：%+v %v", published, err)
			}
		} else {
			if _, err = m.DecideWikiCandidate(ctx, proposals[0].ID, "approved", page.Revision); err != nil {
				t.Fatal(err)
			}
			published, err := m.GetWikiPage(ctx, page.ID)
			if err != nil || published.Revision != 2 || published.Markdown != "必须检查健康状态。" {
				t.Fatalf("竞争候选无法采纳：%+v %v", published, err)
			}
		}
	}
}

func TestWikiExtractionExcludesModelOwnedToolEchoes(t *testing.T) {
	ctx := context.Background()
	s, path := openRuntimeTestStore(t)
	m := &Manager{store: s, deps: Deps{Path: path, Now: s.now, NewID: randomID}}
	space, err := m.CreateWikiSpace(ctx, "事实空间", "business")
	if err != nil {
		t.Fatal(err)
	}
	run := createRuntimeTestRun(t, s, "fact-sources", runtimeStoreTestTime)
	run.Model = &model.Profile{}
	run.Input = "用户明确提供的约定"
	err = s.write(ctx, "test-extraction-facts", func(tx *sql.Tx) error {
		raw, _ := json.Marshal([]string{space.ID})
		if _, err := tx.ExecContext(ctx, "INSERT INTO wiki_run_spaces(run_id,document) VALUES(?,?)", run.ID, string(raw)); err != nil {
			return err
		}
		fixtures := []struct{ name, source, id string }{
			{planTool, "builtin", "model-plan"}, {"wiki_read", "wiki", "wiki-echo"}, {toolSearchName, toolDiscoverySource, "discovery-echo"}, {"load_skill", "skill-load", "skill-echo"}, {userInputTool, "builtin", "question-echo"},
			{"docker_images_list", "builtin", "z-domain"}, {"external_read", "mcp-tool", "a-external"},
		}
		for i, f := range fixtures {
			call := Call{ID: f.id, OperationID: "op-" + f.id, RunID: run.ID, Tool: f.name, Status: StateSucceeded, StepIndex: i, Result: json.RawMessage(`{"fact":"` + f.id + `"}`)}
			if err := saveOperation(ctx, tx, Operation{ID: call.OperationID, RunID: run.ID, CallID: call.ID, ModelRequestID: "test-response", CallIndex: i, Capability: Capability{Name: f.name, Source: f.source}, Status: StateSucceeded}); err != nil {
				return err
			}
			if err := saveCall(ctx, tx, call); err != nil {
				return err
			}
		}
		return m.enqueueWikiNavigationExtraction(ctx, tx, &run)
	})
	if err != nil {
		t.Fatal(err)
	}
	var inputRaw string
	if err = s.db.QueryRowContext(ctx, "SELECT input FROM wiki_jobs WHERE origin_id=?", run.ID).Scan(&inputRaw); err != nil {
		t.Fatal(err)
	}
	var input wikiCompileInput
	if err = json.Unmarshal([]byte(inputRaw), &input); err != nil {
		t.Fatal(err)
	}
	if len(input.Evidence) != 3 || input.Evidence[0].Kind != "user" || input.Evidence[1].ID != "z-domain:1" || input.Evidence[2].ID != "a-external:1" {
		t.Fatalf("混入模型回声或回执顺序丢失：%+v", input.Evidence)
	}
}

func TestWikiCompileSourceUTF8ChunksRetainWholeMaximumInput(t *testing.T) {
	text := strings.Repeat("甲", (16<<10)/3) + "a"
	parts := wikiCompileEvidence("source", "source", "", "memory://source/1", text, "now", 9)
	var restored strings.Builder
	for _, e := range parts {
		restored.WriteString(e.Text)
	}
	if restored.String() != text {
		t.Fatal("16 KiB UTF-8 来源尾部丢失")
	}
}
