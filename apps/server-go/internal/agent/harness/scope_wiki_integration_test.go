package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

type wikiWorkflowIntegrationCatalog struct{ *operationCatalog }

func (c *wikiWorkflowIntegrationCatalog) Snapshot(ctx context.Context, env Environment) (CapabilitySnapshot, error) {
	snapshot, err := c.operationCatalog.Snapshot(ctx, env)
	for i := range snapshot.Tools {
		snapshot.Tools[i].OriginalName = snapshot.Tools[i].Name
		snapshot.Tools[i].CatalogDigest = strings.Repeat("a", 64)
	}
	return snapshot, err
}

// This combines the public lifecycle without external providers: the real
// Worker broker, Wiki store, workflow/v2 scheduler, approvals, memory functions,
// extraction outbox and publication APIs all participate. Container and file
// isolation are covered separately by the real Docker integration tests.
func TestWorkflowV2WikiParallelForeachApprovalSubworkflowAndPublishedRecall(t *testing.T) {
	ctx := context.Background()
	const goal = "数据库巡检：依据 Wiki 并行检查、依次汇总并验证变更"
	const planOutput = `{"alpha":{"id":9007199254740993,"phase":"parallel"},"beta":{"id":2,"phase":"parallel"}}`
	const orderedItems = `[{"id":9007199254740993,"status":"ok"},{"id":2,"status":"ok"}]`
	const verifiedOutput = `{"ordered":[9007199254740993,2],"verified":true}`
	const verifiedSchema = `{"type":"object","properties":{"ordered":{"type":"array","items":{"type":"integer"}},"verified":{"const":true}},"required":["ordered","verified"],"additionalProperties":false}`
	var sourcePageID atomic.Value
	var publishedPageID atomic.Value
	var planRequests, verifyRequests, rootExtractions, finishRequests, memoryRequests, recalls, writes atomic.Int32
	leftStarted, releaseLeft := make(chan struct{}), make(chan struct{})
	var startLeftOnce, releaseLeftOnce sync.Once
	release := func() { releaseLeftOnce.Do(func() { close(releaseLeft) }) }
	t.Cleanup(release)
	var callsMu sync.Mutex
	toolCalls := map[string]int{}
	catalog := &wikiWorkflowIntegrationCatalog{&operationCatalog{execute: func(ctx context.Context, op Operation) (CapabilityResult, error) {
		var args struct {
			ID    json.Number `json:"id"`
			Phase string      `json:"phase"`
		}
		if err := json.Unmarshal([]byte(op.ArgumentsJSON), &args); err != nil {
			return CapabilityResult{}, err
		}
		if op.Capability.Name == "test_write" {
			writes.Add(1)
			if !strings.Contains(op.ArgumentsJSON, orderedItems) || !strings.Contains(op.ArgumentsJSON, `"approved":true`) {
				t.Error("write did not receive the ordered foreach result and human decision")
			}
			return CapabilityResult{Value: json.RawMessage(`{"applied":true,"count":2}`)}, nil
		}
		key := args.Phase + ":" + string(args.ID)
		callsMu.Lock()
		toolCalls[key]++
		callsMu.Unlock()
		if args.Phase == "parallel" && args.ID == "9007199254740993" {
			startLeftOnce.Do(func() { close(leftStarted) })
			select {
			case <-releaseLeft:
			case <-ctx.Done():
				return CapabilityResult{}, ctx.Err()
			}
		}
		if args.Phase == "parallel" && args.ID == "2" {
			select {
			case <-leftStarted:
			case <-ctx.Done():
				return CapabilityResult{}, ctx.Err()
			}
		}
		if args.Phase == "verify" {
			return CapabilityResult{Value: json.RawMessage(`{"verified":true,"marker":"combo-verified-result"}`)}, nil
		}
		value, err := json.Marshal(map[string]any{"id": args.ID, "status": "ok", "privateToolFact": "sibling-private-" + key})
		return CapabilityResult{Value: value}, err
	}}}
	m, source, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		header := ""
		if len(request.Messages) > 1 {
			header = request.Messages[1].Content
		}
		raw, _ := json.Marshal(request.Messages)
		isPlan := strings.Contains(header, "本轮用户输入：\n读取数据库巡检 Wiki 并固定检查输入\n")
		isVerify := strings.Contains(header, "本轮用户输入：\nchild-verifier-")
		switch request.ToolChoice {
		case "store_working_memory":
			memoryRequests.Add(1)
			response := memoryReply(request)
			var proposal memoryProposal
			if err := json.Unmarshal(response.ToolCalls[0].Arguments, &proposal); err != nil {
				return model.Response{}, err
			}
			switch {
			case isPlan:
				proposal.Summary = "combo-plan-memory：读取数据库巡检规则"
			case isVerify:
				proposal.Summary = "combo-child-memory：已验证顺序与批准结果"
			default:
				proposal.Summary = "isolated-source-or-recall-memory"
			}
			response.ToolCalls[0].Arguments, _ = json.Marshal(proposal)
			return response, nil
		case "workflow_finish":
			finishRequests.Add(1)
			if isPlan {
				return workflowFinishReply(planOutput), nil
			}
			if !isVerify || !strings.Contains(string(raw), "combo-verified-result") {
				t.Error("child finish lacks its own verification tool result")
			}
			return workflowFinishReply(verifiedOutput), nil
		case "propose_wiki_pages":
			var input struct {
				Goal    string    `json:"goal"`
				Answer  string    `json:"answer"`
				Sources []WikiRef `json:"wikiSources"`
			}
			if err := json.Unmarshal([]byte(header), &input); err != nil {
				return model.Response{}, err
			}
			if input.Goal != goal {
				return model.Response{FinishReason: "tool_calls", ToolCalls: []model.ToolCall{{ID: "no-pages", Name: "propose_wiki_pages", Arguments: json.RawMessage(`{"pages":[]}`)}}}, nil
			}
			rootExtractions.Add(1)
			if input.Answer != verifiedOutput || len(input.Sources) != 1 || input.Sources[0].PageID != sourcePageID.Load().(string) || len(request.Tools) != 1 {
				t.Errorf("root extraction lost verified output/source or gained tools: %+v", input)
			}
			return model.Response{FinishReason: "tool_calls", ToolCalls: []model.ToolCall{{ID: "root-wiki-proposal", Name: "propose_wiki_pages", Arguments: json.RawMessage(`{"pages":[{"slug":"verified-database-review","title":"数据库巡检 已验证经验","markdown":"combo-published-lesson：保持输入顺序汇总检查结果，审批后执行并独立验证。","kind":"runbook"}]}`)}}}, nil
		}
		if isPlan || isVerify {
			if strings.Contains(string(raw), "source-session-private") || strings.Contains(string(raw), "isolated-source-or-recall-memory") || strings.Contains(string(raw), "sibling-private-") {
				t.Error("source session or sibling private facts leaked into workflow agent context")
			}
		}
		if isPlan {
			if planRequests.Add(1) == 1 {
				response := toolReply("wiki_read")
				response.ToolCalls[0].Arguments, _ = json.Marshal(map[string]string{"pageId": sourcePageID.Load().(string)})
				return response, nil
			}
			if !strings.Contains(string(raw), "combo-origin-policy") {
				t.Error("planner did not receive the Wiki page")
			}
			return finalReply("已读取规则并固定两项检查输入"), nil
		}
		if isVerify {
			if missingOperationTools(request, "test_read") {
				return searchReply("test_read"), nil
			}
			if !strings.Contains(header, "child-verifier-v1") || strings.Contains(header, "child-verifier-v2") || !strings.Contains(header, orderedItems) || !strings.Contains(header, `"applied":true`) || !strings.Contains(header, "combo-plan-memory") {
				t.Errorf("child lost accepted definition, ordered inputs, action or inherited memory: %s", header)
			}
			if verifyRequests.Add(1) == 1 {
				response := toolReply("test_read")
				response.ToolCalls[0].Arguments = json.RawMessage(`{"id":3,"phase":"verify"}`)
				return response, nil
			}
			return finalReply("已独立验证顺序、人工确认和操作结果"), nil
		}
		if strings.Contains(header, "fresh-recall-session") {
			if recalls.Add(1) == 1 {
				if strings.Contains(string(raw), "combo-published-lesson") {
					t.Error("navigation injected page body before a read")
				}
				response := toolReply("wiki_read")
				response.ToolCalls[0].Arguments, _ = json.Marshal(map[string]string{"pageId": publishedPageID.Load().(string)})
				return response, nil
			}
			if !strings.Contains(string(raw), "combo-published-lesson") || strings.Contains(string(raw), "sibling-private-") {
				t.Error("new session did not recall only published knowledge")
			}
			return finalReply("召回已发布的数据库巡检经验"), nil
		}
		return finalReply("source-session-private：源会话独有的公开历史"), nil
	}, func(d *Deps) { d.Catalog = catalog; d.Limits.Concurrency = 2 })
	seed := submitAgentTest(t, m, source, "combo-source-seed", "source-session-private")
	if got := runtimeFinished(t, m, seed.ID); got.Status != StateSucceeded {
		t.Fatalf("source seed failed: %+v", got)
	}
	space, err := m.CreateWikiSpace(ctx, "组合验收业务知识", "business")
	if err != nil {
		t.Fatal(err)
	}
	page, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "database-policy", Title: "数据库巡检", Markdown: "combo-origin-policy：先检查再批准，汇总保持原始输入顺序。", Kind: "runbook"})
	if err != nil {
		t.Fatal(err)
	}
	sourcePageID.Store(page.ID)
	if _, err = m.SetWikiSessionSpace(ctx, source.ID, space.ID, false); err != nil {
		t.Fatal(err)
	}
	pointer := "/id"
	rule, err := m.PutResourceRule(ctx, "", 0, ResourceRuleInput{Name: "验收只读资源", Enabled: true, Complete: true, Selector: ResourceSelector{Source: "mcp-tool", Ref: RevisionRef{ID: "fixture-server", Revision: 1}, OriginalName: "test_read", CatalogDigest: strings.Repeat("a", 64)}, Mappings: []ResourceMapping{{Kind: "database", Authority: "fixture", Access: "read", Pointer: &pointer}}})
	if err != nil {
		t.Fatal(err)
	}
	env, err := m.GetEnvironment(ctx, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	env.TrustedReadOnly = []string{"test_read"}
	env.Servers = []RevisionRef{{ID: "fixture-server", Revision: 1, Digest: strings.Repeat("a", 64)}}
	env.ResourceRules = []RevisionRef{{ID: rule.ID, Revision: rule.Revision, Digest: rule.Digest}}
	if _, err = m.PutEnvironment(ctx, source.ID, env.Revision, env); err != nil {
		t.Fatal(err)
	}

	childFinish := workflowTestOutput("verify", "")
	child, err := m.PutWorkflowDefinition(ctx, "", 0, WorkflowDefinition{LanguageVersion: WorkflowV2LanguageVersion, Name: "固定验证子流程", Enabled: true, Goal: "只验证已提交结果", InputSchemaJSON: `{"type":"object"}`, OutputSchemaJSON: verifiedSchema, Entry: "verify", Steps: []WorkflowStepDefinition{{ID: "verify", Kind: "agent", Instruction: "child-verifier-v1：独立检查输入顺序及操作结果", Input: workflowTestInput(""), OutputSchemaJSON: verifiedSchema, Finish: &childFinish}}})
	if err != nil {
		t.Fatal(err)
	}
	leaf := func(phase string) WorkflowBody {
		input := workflowTestInput("")
		if phase != "parallel" {
			input = WorkflowBinding{Object: map[string]WorkflowBinding{"id": workflowTestInput("/id"), "phase": workflowLiteral(`"loop"`)}}
		}
		finish := WorkflowBinding{Object: map[string]WorkflowBinding{"id": workflowTestOutput("inspect", "/id"), "status": workflowTestOutput("inspect", "/status")}}
		return WorkflowBody{Entry: "inspect", OutputSchemaJSON: `{"type":"object"}`, Steps: []WorkflowStepDefinition{{ID: "inspect", Kind: "operation", Capability: "test_read", Input: input, OutputSchemaJSON: `{"type":"object"}`, Finish: &finish}}}
	}
	rootFinish := workflowTestOutput("validate", "")
	definition := WorkflowDefinition{LanguageVersion: WorkflowV2LanguageVersion, Name: "Wiki完整组合验收", Enabled: true, Goal: goal, InputSchemaJSON: `{"type":"object"}`, OutputSchemaJSON: verifiedSchema, Entry: "plan", Steps: []WorkflowStepDefinition{
		{ID: "plan", Kind: "agent", Instruction: "读取数据库巡检 Wiki 并固定检查输入", Input: workflowTestInput(""), OutputSchemaJSON: `{"type":"object"}`, Next: "parallel"},
		{ID: "parallel", Kind: "parallel", Input: workflowTestOutput("plan", ""), OutputSchemaJSON: `{"type":"object"}`, Parallel: &WorkflowParallel{Join: "all", Branches: []WorkflowBranch{{ID: "alpha", Input: workflowTestInput("/alpha"), Body: leaf("parallel")}, {ID: "beta", Input: workflowTestInput("/beta"), Body: leaf("parallel")}}}, Next: "each"},
		{ID: "each", Kind: "foreach", Input: WorkflowBinding{Array: []WorkflowBinding{workflowTestOutput("parallel", "/alpha"), workflowTestOutput("parallel", "/beta")}}, Foreach: &WorkflowForeach{Items: workflowTestInput(""), Body: leaf("loop")}, OutputSchemaJSON: `{"type":"array"}`, Next: "confirm"},
		{ID: "confirm", Kind: "approval", Instruction: "确认按输入顺序汇总的结果", Input: workflowTestOutput("each", ""), OutputSchemaJSON: `{"type":"object"}`, Next: "act"},
		{ID: "act", Kind: "operation", Capability: "test_write", Input: WorkflowBinding{Object: map[string]WorkflowBinding{"items": workflowTestOutput("each", ""), "approval": workflowTestOutput("confirm", "")}}, OutputSchemaJSON: `{"type":"object"}`, Next: "validate"},
		{ID: "validate", Kind: "subworkflow", Input: WorkflowBinding{Object: map[string]WorkflowBinding{"items": workflowTestOutput("each", ""), "action": workflowTestOutput("act", "")}}, Subworkflow: &WorkflowSubworkflow{DefinitionID: child.ID, DefinitionRevision: child.Revision}, OutputSchemaJSON: verifiedSchema, Finish: &rootFinish},
	}}
	w := createWorkflowV2Test(t, m, source, definition, `{}`)
	// Force the second branch to finish while the first still occupies a worker.
	// Stable aggregation must follow declaration/input order, not completion order.
	runtimeEventually(t, func() bool {
		current, err := m.GetWorkflow(ctx, w.ID)
		if err != nil || current.ExecutionTree == nil {
			return false
		}
		for _, scope := range current.ExecutionTree.Scopes {
			if strings.HasSuffix(scope.Path, "/beta") && scope.Status == StateSucceeded {
				return true
			}
		}
		return false
	})
	release()
	w = workflowWait(t, m, w.ID, StateWaitingApproval)
	gate := waitingApproval(t, m, w.ActiveRunID)
	if gate.Kind != "workflow-gate" || gate.InputJSON != orderedItems || writes.Load() != 0 {
		t.Fatalf("wrong approval boundary or aggregation: %+v writes=%d", gate, writes.Load())
	}
	jobs, err := m.ListWikiJobs(ctx, "", 50)
	if err != nil || len(jobs.Items) != 0 || rootExtractions.Load() != 0 {
		t.Fatalf("child step auto-extracted before root completion: %+v %v", jobs, err)
	}
	// Updating the stored child cannot alter the accepted root's closure.
	updatedChild := child
	updatedChild.Steps = append([]WorkflowStepDefinition(nil), child.Steps...)
	updatedChild.Steps[0].Instruction = "child-verifier-v2：不应进入已接受的根流程"
	if _, err = m.PutWorkflowDefinition(ctx, child.ID, child.Revision, updatedChild); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Decide(ctx, gate.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	var actionApproval Approval
	runtimeEventually(t, func() bool {
		approvals, e := m.ApprovalsFiltered(ctx, w.ID)
		if e != nil {
			return false
		}
		for _, approval := range approvals {
			if approval.Status == "pending" && approval.Kind == "operation" {
				actionApproval = approval
				return true
			}
		}
		return false
	})
	if writes.Load() != 0 || actionApproval.Operation.Capability.Name != "test_write" {
		t.Fatal("human gate bypassed the independent write approval")
	}
	if _, err = m.Decide(ctx, actionApproval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	w = workflowWait(t, m, w.ID, StateSucceeded)
	if w.OutputJSON != verifiedOutput || writes.Load() != 1 || finishRequests.Load() != 2 || planRequests.Load() != 2 || verifyRequests.Load() != 2 {
		t.Fatalf("full workflow did not execute exactly once: %+v", w)
	}
	if len(w.ExecutionTree.Scopes) != 6 || len(w.Definitions) != 2 {
		t.Fatalf("unexpected isolation tree/definition closure: %+v", w.ExecutionTree)
	}
	tasks := map[string]bool{seed.TaskID: true}
	ref := WikiRef{page.ID, page.Revision, page.Digest}
	for _, scope := range w.ExecutionTree.Scopes {
		if tasks[scope.TaskID] || scope.Status != StateSucceeded {
			t.Fatalf("scope reused a task: %+v", scope)
		}
		tasks[scope.TaskID] = true
		memory, err := m.Memory(ctx, scope.TaskID, 0)
		if err != nil || memory.TaskID != scope.TaskID || strings.Contains(memory.Summary, "isolated-source-or-recall-memory") {
			t.Fatalf("scope memory not isolated: %+v %v", memory, err)
		}
		if scope.ParentScopeID != "" {
			m.mu.Lock()
			refs, err := wikiArtifactRefs(ctx, m.store.db, "workflow-scope", scope.ID)
			m.mu.Unlock()
			if err != nil || len(refs) != 1 || refs[0] != ref {
				t.Fatalf("Wiki source not inherited by %s: %+v %v", scope.Path, refs, err)
			}
		}
	}
	callsMu.Lock()
	for _, key := range []string{"parallel:9007199254740993", "parallel:2", "loop:9007199254740993", "loop:2", "verify:3"} {
		if toolCalls[key] != 1 {
			t.Errorf("tool %s executed %d times", key, toolCalls[key])
		}
	}
	callsMu.Unlock()
	runtimeEventually(t, func() bool {
		jobs, err = m.ListWikiJobs(ctx, "", 50)
		return err == nil && len(jobs.Items) == 1 && terminal(jobs.Items[0].Status)
	})
	job := jobs.Items[0]
	if job.Status != StateSucceeded || job.OriginKind != "workflow" || job.OriginID != w.ID || len(job.CandidateIDs) != 1 || rootExtractions.Load() != 1 || len(job.Sources) != 1 || job.Sources[0] != ref {
		t.Fatalf("root extraction was not unique or lost sources: %+v calls=%d", job, rootExtractions.Load())
	}
	candidates, err := m.ListWikiCandidates(ctx, space.ID, "pending")
	if err != nil || len(candidates) != 1 {
		t.Fatalf("missing reviewable candidate: %+v %v", candidates, err)
	}
	candidate := candidates[0]
	if len(candidate.Page.Sources) != 1 || candidate.Page.Sources[0] != ref || len(candidate.Page.Evidence) != 1 || candidate.Page.Evidence[0].Kind != "workflow" || candidate.Page.Evidence[0].ID != w.ID {
		t.Fatalf("candidate lost root provenance: %+v", candidate)
	}
	pages, err := m.ListWikiPages(ctx, space.ID, false)
	if err != nil || len(pages) != 1 {
		t.Fatalf("unapproved candidate was published: %+v %v", pages, err)
	}
	published, err := m.DecideWikiCandidate(ctx, candidate.ID, "approved")
	if err != nil {
		t.Fatal(err)
	}
	learned, err := m.GetWikiPage(ctx, published.PageID)
	if err != nil || learned.Status != "active" || len(learned.Sources) != 1 || learned.Sources[0] != ref {
		t.Fatalf("published page lost original source: %+v %v", learned, err)
	}
	publishedPageID.Store(learned.ID)
	fresh, err := m.CreateSession(ctx, CreateSessionInput{Title: "独立召回会话", ModelProfileID: source.ModelProfileID, ModelRevision: source.ModelRevision})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SetWikiSessionSpace(ctx, fresh.ID, space.ID, false); err != nil {
		t.Fatal(err)
	}
	recall := submitAgentTest(t, m, fresh, "combo-fresh-recall", "fresh-recall-session：数据库巡检 已验证经验")
	if got := runtimeFinished(t, m, recall.ID); got.Status != StateSucceeded || recalls.Load() != 2 || tasks[got.TaskID] {
		t.Fatalf("new session recall failed or reused task: %+v", got)
	}
	m.mu.Lock()
	recallRefs, err := wikiArtifactRefs(ctx, m.store.db, "run", recall.ID)
	m.mu.Unlock()
	foundPublished, foundOrigin := false, false
	for _, source := range recallRefs {
		foundPublished = foundPublished || source.PageID == learned.ID && source.Revision == learned.Revision && source.Digest == learned.Digest
		foundOrigin = foundOrigin || source == ref
	}
	if err != nil || !foundPublished || !foundOrigin {
		t.Fatalf("recall did not retain published and transitive sources: %+v %v", recallRefs, err)
	}
	if memoryRequests.Load() < 4 || rootExtractions.Load() != 1 {
		t.Fatal(fmt.Sprintf("missing memory function or duplicate root extraction: memory=%d root=%d", memoryRequests.Load(), rootExtractions.Load()))
	}
}
