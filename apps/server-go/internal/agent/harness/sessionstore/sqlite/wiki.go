package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/harness/workspace"
)

type wikiQuery interface {
	rowReader
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func copyWikiSessionSpaces(ctx context.Context, tx *sql.Tx, source, target string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO wiki_session_spaces(session_id,document) SELECT ?,document FROM wiki_session_spaces WHERE session_id=? ON CONFLICT(session_id) DO UPDATE SET document=excluded.document`, target, source)
	return err
}

func snapshotWikiRunSpaces(ctx context.Context, tx *sql.Tx, runID, sessionID string) error {
	var raw string
	err := tx.QueryRowContext(ctx, "SELECT document FROM wiki_session_spaces WHERE session_id=?", sessionID).Scan(&raw)
	ids := []string{}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil {
		var d WikiSpaceSelection
		if e := json.Unmarshal([]byte(raw), &d); e != nil {
			return e
		}
		if d.SpaceID != "" {
			ids = append(ids, d.SpaceID)
		}
		if d.IncludeGlobal {
			var global string
			e := tx.QueryRowContext(ctx, "SELECT id FROM wiki_spaces WHERE kind='global'").Scan(&global)
			if e != nil && !errors.Is(e, sql.ErrNoRows) {
				return e
			}
			if global != "" && global != d.SpaceID {
				ids = append(ids, global)
			}
		}
	}
	b, _ := json.Marshal(ids)
	if _, err = tx.ExecContext(ctx, "INSERT INTO wiki_run_spaces(run_id,document) VALUES(?,?) ON CONFLICT(run_id) DO NOTHING", runID, string(b)); err != nil {
		return err
	}
	var workflowID string
	if err = tx.QueryRowContext(ctx, "SELECT workflow_id FROM runs WHERE id=?", runID).Scan(&workflowID); err != nil {
		return err
	}
	if workflowID != "" {
		_, err = tx.ExecContext(ctx, "INSERT INTO wiki_visible_pages(owner_kind,owner_id,page_id,revision,digest) SELECT 'run',?,page_id,revision,digest FROM wiki_visible_pages WHERE owner_kind='workflow' AND owner_id=? ON CONFLICT DO NOTHING", runID, workflowID)
	} else {
		err = snapshotWikiVisible(ctx, tx, "run", runID, ids)
	}
	if err != nil {
		return err
	}
	var taskID string
	if err = tx.QueryRowContext(ctx, "SELECT task_id FROM runs WHERE id=?", runID).Scan(&taskID); err != nil {
		return err
	}
	generation, err := wikiGeneration(ctx, tx, taskID)
	if err != nil {
		return err
	}
	var inherited []WikiRef
	if workflowID != "" {
		w, e := readWorkflow(ctx, tx, workflowID)
		if e != nil {
			return e
		}
		if w.LanguageVersion != WorkflowV2LanguageVersion {
			prior, e := readDocuments[Run](ctx, tx, "SELECT document FROM runs WHERE workflow_id=? AND state='succeeded'", workflowID)
			if e != nil {
				return e
			}
			artifacts := []workflowWikiArtifact{}
			for _, r := range prior {
				artifacts = append(artifacts, workflowWikiArtifact{"run", r.ID})
			}
			memory, e := latestMemory(ctx, tx, taskID)
			if e != nil {
				return e
			}
			version, e := readWorkspaceVersion(ctx, tx, taskID)
			if e != nil {
				return e
			}
			artifacts = append(artifacts, workflowWikiArtifact{"memory", taskID + ":" + strconv.Itoa(memory.Revision)}, workflowWikiArtifact{"workspace", state.WorkspaceWikiKey(version)})
			inherited, e = workflowWikiSources(ctx, tx, artifacts)
			if e != nil {
				return e
			}
		}
	}
	return saveWikiArtifact(ctx, tx, "run", runID, taskID, runID, generation, inherited)
}

func snapshotWikiVisible(ctx context.Context, tx *sql.Tx, kind, id string, spaces []string) error {
	for _, space := range spaces {
		_, err := tx.ExecContext(ctx, `INSERT INTO wiki_visible_pages(owner_kind,owner_id,page_id,revision,digest) SELECT ?,?,id,current_revision,json_extract(document,'$.digest') FROM wiki_pages WHERE space_id=? AND status='active' AND (COALESCE(json_extract(document,'$.expiresAt'),'')='' OR julianday(json_extract(document,'$.expiresAt'))>julianday('now')) ON CONFLICT DO NOTHING`, kind, id, space)
		if err != nil {
			return err
		}
	}
	return nil
}

func snapshotWikiWorkflow(ctx context.Context, tx *sql.Tx, w WorkflowInstance) error {
	if err := copyWikiSessionSpaces(ctx, tx, w.SourceSessionID, w.SessionID); err != nil {
		return err
	}
	var raw string
	err := tx.QueryRowContext(ctx, "SELECT document FROM wiki_session_spaces WHERE session_id=?", w.SessionID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var selection WikiSpaceSelection
	if err = json.Unmarshal([]byte(raw), &selection); err != nil {
		return err
	}
	spaces := []string{}
	if selection.SpaceID != "" {
		spaces = append(spaces, selection.SpaceID)
	}
	if selection.IncludeGlobal {
		var global string
		err = tx.QueryRowContext(ctx, "SELECT id FROM wiki_spaces WHERE kind='global'").Scan(&global)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if global != "" {
			spaces = append(spaces, global)
		}
	}
	return snapshotWikiVisible(ctx, tx, "workflow", w.ID, spaces)
}

func wikiGeneration(ctx context.Context, q rowReader, taskID string) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, "SELECT generation FROM wiki_task_contexts WHERE task_id=?", taskID).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return n, err
}

func wikiArtifactInvalid(ctx context.Context, q rowReader, kind, id string) (bool, error) {
	var invalid int
	err := q.QueryRowContext(ctx, "SELECT invalidated FROM wiki_artifacts WHERE kind=? AND id=?", kind, id).Scan(&invalid)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return invalid != 0, err
}

func validateWikiSources(ctx context.Context, q rowReader, refs []WikiRef) error {
	for _, r := range refs {
		var digest, status string
		var invalid int
		err := q.QueryRowContext(ctx, `SELECT rev.digest,p.status,COALESCE(a.invalidated,0) FROM wiki_page_revisions rev JOIN wiki_pages p ON p.id=rev.page_id LEFT JOIN wiki_artifacts a ON a.kind='page' AND a.id=rev.page_id||':'||rev.revision WHERE rev.page_id=? AND rev.revision=?`, r.PageID, r.Revision).Scan(&digest, &status, &invalid)
		if errors.Is(err, sql.ErrNoRows) || err == nil && (digest != r.Digest || status == "withdrawn" || invalid != 0) {
			return &Error{Status: 409, Code: "wiki-source-withdrawn", Message: "引用的 Wiki 页面已撤回或修订证据无效"}
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func saveWikiArtifact(ctx context.Context, tx *sql.Tx, kind, id, taskID, runID string, generation int, refs []WikiRef) error {
	// 将页面间来源闭包展开为直接依赖，任何上游撤回都能一次命中全部派生物。
	refs = state.MergeWikiRefs(refs)
	seen := map[string]bool{}
	for _, r := range refs {
		seen[state.WikiRefKey(r)] = true
	}
	for i := 0; i < len(refs); i++ {
		parents, e := wikiArtifactRefs(ctx, tx, "page", state.WikiRefKey(refs[i]))
		if e != nil {
			return e
		}
		for _, p := range parents {
			if !seen[state.WikiRefKey(p)] {
				refs = append(refs, p)
				seen[state.WikiRefKey(p)] = true
			}
		}
		if len(refs) > 1024 {
			return bad("wiki-dependency-limit", "Wiki 来源依赖数量超过限额")
		}
	}
	if len(refs) > 1024 {
		return bad("wiki-dependency-limit", "Wiki 来源依赖数量超过限额，请新建任务")
	}
	if err := validateWikiSources(ctx, tx, refs); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO wiki_artifacts(kind,id,task_id,run_id,generation) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO NOTHING`, kind, id, taskID, runID, generation); err != nil {
		return err
	}
	for _, r := range state.MergeWikiRefs(refs) {
		if _, err := tx.ExecContext(ctx, "INSERT INTO wiki_dependencies(kind,id,page_id,revision,digest) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING", kind, id, r.PageID, r.Revision, r.Digest); err != nil {
			return err
		}
	}
	return nil
}

type WikiSpaceSelection = state.WikiSpaceSelection

func wikiArtifactRefs(ctx context.Context, q wikiQuery, kind, id string) ([]WikiRef, error) {
	rows, err := q.QueryContext(ctx, "SELECT page_id,revision,digest FROM wiki_dependencies WHERE kind=? AND id=? ORDER BY page_id,revision", kind, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WikiRef{}
	for rows.Next() {
		var r WikiRef
		if err = rows.Scan(&r.PageID, &r.Revision, &r.Digest); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// 只把真正派发并成功完成的能力结果当作新观察；计划、知识回读和目录加载是上下文回声。
func wikiToolEvidenceAllowed(ctx context.Context, tx *sql.Tx, call Call) (bool, error) {
	if call.OperationID == "" || call.Status != StateSucceeded || len(call.Result) == 0 || strings.HasPrefix(call.Tool, "wiki_") || call.Tool == planTool || call.Tool == userInputTool {
		return false, nil
	}
	op, err := readOperation(ctx, tx, call.OperationID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if op.RunID != call.RunID || op.CallID != call.ID || op.Status != StateSucceeded || op.Capability.Name != call.Tool {
		return false, nil
	}
	switch op.Capability.Source {
	case "builtin", "workspace", "script", BashSource, "mcp-tool", "mcp-resource":
		return true, nil
	default:
		return false, nil
	}
}

// 人工证据也继承其来源，省略 Sources 字段不能把旧回答洗成无来源的新页面。
func wikiEvidenceSources(ctx context.Context, tx *sql.Tx, e WikiEvidence) ([]WikiRef, error) {
	if e.Kind == "source" {
		p, err := wikiEvidenceSourcePage(ctx, tx, e)
		if err != nil {
			return nil, err
		}
		return []WikiRef{{PageID: p.ID, Revision: p.Revision, Digest: p.Digest}}, nil
	}
	if e.RunID != "" {
		return wikiArtifactRefs(ctx, tx, "run", e.RunID)
	}
	if e.Kind != "workflow" {
		return nil, nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT d.page_id,d.revision,d.digest FROM wiki_dependencies d JOIN wiki_artifacts a ON a.kind=d.kind AND a.id=d.id WHERE a.run_id IN (SELECT id FROM runs WHERE workflow_id=?) OR (a.kind='workflow-scope' AND a.id IN (SELECT id FROM workflow_scopes WHERE workflow_id=?)) OR (a.kind='extraction' AND a.id IN (SELECT id FROM wiki_jobs WHERE origin_kind='workflow' AND origin_id=?))`, e.ID, e.ID, e.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	refs := []WikiRef{}
	for rows.Next() {
		var ref WikiRef
		if err := rows.Scan(&ref.PageID, &ref.Revision, &ref.Digest); err != nil {
			return nil, err
		}
		refs = append(refs, ref)
	}
	return refs, rows.Err()
}

// 成功状态只证明运行终态；证据正文仍必须逐字来自已保存的公开答复、结果或工具回执。
func validateWikiEvidence(ctx context.Context, tx *sql.Tx, e *WikiEvidence) error {
	e.OriginalCleared = false
	if e.Kind == "source" {
		_, err := wikiEvidenceSourcePage(ctx, tx, *e)
		return err
	}
	if e.Kind == "workflow" {
		if e.ID == "" || e.RunID != "" {
			return bad("wiki-evidence-invalid", "工作流证据必须提供唯一的根工作流编号")
		}
		workflow, err := readWorkflow(ctx, tx, e.ID)
		if err != nil {
			var own *Error
			if !errors.As(err, &own) || own.Status != 404 {
				return err
			}
			var known int
			if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM wiki_page_revisions r,json_each(r.document,'$.evidence') e WHERE json_extract(e.value,'$.kind')='workflow' AND json_extract(e.value,'$.id')=? AND json_extract(e.value,'$.text')=?`, e.ID, e.Text).Scan(&known); err != nil {
				return err
			}
			if known == 0 {
				return bad("wiki-evidence-invalid", "工作流证据来源不存在")
			}
			e.OriginalCleared = true
			return nil
		}
		if workflow.Status != StateSucceeded {
			return bad("wiki-evidence-unconfirmed", "未成功工作流不能作为成功证据")
		}
		if !strings.Contains(workflow.OutputJSON, e.Text) {
			return bad("wiki-evidence-mismatch", "工作流证据摘录不在保存的公开结果中")
		}
		return nil
	}
	if e.RunID == "" {
		if e.Kind == "run" || e.Kind == "user" || e.Kind == "tool" {
			return bad("wiki-evidence-invalid", "运行证据缺少运行编号")
		}
		return nil
	}
	run, err := readRun(ctx, tx, e.RunID)
	if err != nil {
		var own *Error
		if !errors.As(err, &own) || own.Status != 404 {
			return err
		}
		var known int
		if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM wiki_page_revisions r,json_each(r.document,'$.evidence') e JOIN wiki_cleared_sources c ON c.run_id=json_extract(e.value,'$.runId') WHERE json_extract(e.value,'$.runId')=? AND json_extract(e.value,'$.text')=? AND COALESCE(json_extract(e.value,'$.eventSeq'),'')=?`, e.RunID, e.Text, e.EventSeq).Scan(&known); err != nil {
			return err
		}
		if known == 0 {
			return bad("wiki-evidence-invalid", "证据运行不存在，不能确认成功事实")
		}
		e.OriginalCleared = true
		return nil
	}
	if run.Status != StateSucceeded {
		return bad("wiki-evidence-unconfirmed", "未确认或未成功执行不能作为成功证据")
	}
	if e.Kind == "user" {
		if strings.Contains(run.Input, e.Text) {
			return nil
		}
		return bad("wiki-evidence-mismatch", "用户证据不在该轮实际输入中")
	}
	if e.Kind == "tool" {
		calls, err := readDocuments[Call](ctx, tx, "SELECT document FROM calls WHERE run_id=? AND state='succeeded'", e.RunID)
		if err != nil {
			return err
		}
		for _, call := range calls {
			allowed, err := wikiToolEvidenceAllowed(ctx, tx, call)
			if err != nil {
				return err
			}
			if allowed && strings.HasPrefix(e.ID, call.ID+":") && strings.Contains(string(call.Result), e.Text) {
				return nil
			}
		}
		return bad("wiki-evidence-mismatch", "工具证据不在指定成功回执中")
	}
	if e.EventSeq != "" {
		seq, err := strconv.ParseInt(e.EventSeq, 10, 64)
		if err != nil || seq <= 0 || strconv.FormatInt(seq, 10) != e.EventSeq {
			return bad("wiki-evidence-invalid", "证据事件序号无效")
		}
		var count int
		if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM run_events WHERE run_id=? AND seq=?", e.RunID, seq).Scan(&count); err != nil {
			return err
		}
		if count != 1 {
			return bad("wiki-evidence-invalid", "证据事件不属于指定运行")
		}
	}
	var matches int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM messages WHERE run_id=? AND role='assistant' AND instr(json_extract(document,'$.content'),?)>0", e.RunID, e.Text).Scan(&matches); err != nil {
		return err
	}
	if matches != 0 || run.WorkflowOutputJSON != "" && strings.Contains(run.WorkflowOutputJSON, e.Text) {
		return nil
	}
	calls, err := readDocuments[Call](ctx, tx, "SELECT document FROM calls WHERE run_id=? AND state='succeeded'", e.RunID)
	if err != nil {
		return err
	}
	for _, call := range calls {
		if len(call.Result) != 0 && strings.Contains(string(call.Result), e.Text) {
			return nil
		}
	}
	return bad("wiki-evidence-mismatch", "证据摘录不在该运行保存的公开答复或成功结果中")
}

func wikiEvidenceSourcePage(ctx context.Context, tx *sql.Tx, e WikiEvidence) (WikiPage, error) {
	parts := strings.Split(strings.TrimPrefix(e.URI, "memory://"), "/")
	if !strings.HasPrefix(e.URI, "memory://") || len(parts) != 2 {
		return WikiPage{}, bad("wiki-evidence-invalid", "来源证据必须绑定精确页面修订")
	}
	rev, err := strconv.Atoi(parts[1])
	if err != nil || rev < 1 {
		return WikiPage{}, bad("wiki-evidence-invalid", "来源修订无效")
	}
	var raw string
	if err = tx.QueryRowContext(ctx, "SELECT document FROM wiki_page_revisions WHERE page_id=? AND revision=?", parts[0], rev).Scan(&raw); err != nil {
		return WikiPage{}, err
	}
	var p WikiPage
	if err = state.DecodeWiki(raw, &p); err != nil {
		return p, err
	}
	if p.Kind != "sources" || !strings.HasPrefix(e.ID, p.ID+":") || !strings.Contains(p.Markdown, e.Text) {
		return p, bad("wiki-evidence-mismatch", fmt.Sprintf("来源证据与修订 %d 不符", rev))
	}
	return p, nil
}

func saveWikiJob(ctx context.Context, tx *sql.Tx, job WikiJob) error {
	job.Model = job.Model.Public()
	raw, err := json.Marshal(storedWikiJob{WikiJob: job, Response: job.Response})
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO wiki_jobs(id,kind,origin_kind,origin_id,state,document,input) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document`, job.ID, job.Kind, job.OriginKind, job.OriginID, job.Status, string(raw), job.Input)
	return err
}

func readWikiJob(ctx context.Context, q rowReader, id string) (WikiJob, error) {
	var raw, input string
	err := q.QueryRowContext(ctx, "SELECT document,input FROM wiki_jobs WHERE id=?", id).Scan(&raw, &input)
	if errors.Is(err, sql.ErrNoRows) {
		return WikiJob{}, &Error{Status: 404, Code: "memory-extraction-not-found", Message: "长期记忆提炼任务不存在"}
	}
	if err != nil {
		return WikiJob{}, err
	}
	var stored storedWikiJob
	if err = json.Unmarshal([]byte(raw), &stored); err != nil {
		return WikiJob{}, err
	}
	stored.WikiJob.Input, stored.WikiJob.Response = input, stored.Response
	return stored.WikiJob, nil
}

type storedWikiJob struct {
	WikiJob
	Response *model.Response `json:"response,omitempty"`
}

// 唯一全局空间与新会话绑定在同一事务；旧会话不补写选择。
func ensureGlobalWikiSpace(ctx context.Context, tx *sql.Tx, now string) (WikiSpace, error) {
	var raw string
	err := tx.QueryRowContext(ctx, "SELECT document FROM wiki_spaces WHERE kind='global'").Scan(&raw)
	if err == nil {
		var space WikiSpace
		err = json.Unmarshal([]byte(raw), &space)
		return space, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return WikiSpace{}, err
	}
	space := WikiSpace{ID: state.RandomID(), Revision: 1, Name: "全局记忆", Kind: "global", CreatedAt: now}
	b, _ := json.Marshal(space)
	if _, err = tx.ExecContext(ctx, "INSERT INTO wiki_spaces(id,name,kind,document) VALUES(?,?,?,?)", space.ID, space.Name, space.Kind, string(b)); err != nil {
		return WikiSpace{}, err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO wiki_space_revisions(id,revision,document) VALUES(?,?,?)", space.ID, 1, string(b))
	return space, err
}

const wikiNavigationStrategy = "navigation/v1"

const wikiDisabledStrategy = "disabled/v1"

func recordWikiRunArtifact(ctx context.Context, tx *sql.Tx, r Run, kind, id string) error {
	refs, err := wikiArtifactRefs(ctx, tx, "run", r.ID)
	if err != nil {
		return err
	}
	generation, err := wikiGeneration(ctx, tx, r.TaskID)
	if err != nil {
		return err
	}
	if err = validateWikiRun(ctx, tx, r.ID); err != nil {
		return err
	}
	return saveWikiArtifact(ctx, tx, kind, id, r.TaskID, r.ID, generation, refs)
}

func recordWikiFinal(ctx context.Context, tx *sql.Tx, r Run, memory *WorkingMemory) error {
	if memory != nil {
		if err := recordWikiRunArtifact(ctx, tx, r, "memory", r.TaskID+":"+strconv.Itoa(memory.Revision)); err != nil {
			return err
		}
	}
	var message string
	if err := tx.QueryRowContext(ctx, "SELECT id FROM messages WHERE run_id=? AND role='assistant'", r.ID).Scan(&message); err != nil {
		return err
	}
	return recordWikiRunArtifact(ctx, tx, r, "message", message)
}

// publishWikiPage 与候选决定共用同一事务，发布内容和来源不可分离。
func publishWikiPage(ctx context.Context, tx *sql.Tx, p *WikiPage, expected int) error {
	if p.Status != "withdrawn" {
		if err := validateWikiSources(ctx, tx, p.Sources); err != nil {
			return err
		}
	}
	if p.Evidence == nil {
		p.Evidence = []WikiEvidence{}
	}
	if p.Sources == nil {
		p.Sources = []WikiRef{}
	}
	if p.Links == nil {
		p.Links = []string{}
	}
	for i := range p.Evidence {
		e := &p.Evidence[i]
		if e.CreatedAt == "" {
			e.CreatedAt = p.UpdatedAt
		}
		e.Digest = state.WikiDigest(e.Kind, e.Text)
		if err := validateWikiEvidence(ctx, tx, e); err != nil {
			return err
		}
		if p.Status != "withdrawn" {
			refs, err := wikiEvidenceSources(ctx, tx, *e)
			if err != nil {
				return err
			}
			p.Sources = state.MergeWikiRefs(p.Sources, refs)
		}
	}
	if p.Status != "withdrawn" {
		if err := validateWikiSources(ctx, tx, p.Sources); err != nil {
			return err
		}
	}
	if expected == 0 {
		var count int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM wiki_pages WHERE status='active'").Scan(&count); err != nil {
			return err
		}
		if count >= wikiPageLimit {
			return &Error{Status: 429, Code: "wiki-page-limit", Message: "有效 Wiki 页面已达到 10000 页上限"}
		}
		var exists int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM wiki_pages WHERE space_id=? AND slug=?", p.SpaceID, p.Slug).Scan(&exists); err != nil {
			return err
		}
		if exists != 0 {
			return &Error{Status: 409, Code: "wiki-slug-conflict", Message: "空间中已存在相同 slug 的页面"}
		}
	} else {
		var current int
		if err := tx.QueryRowContext(ctx, "SELECT current_revision FROM wiki_pages WHERE id=?", p.ID).Scan(&current); err != nil {
			return err
		}
		if current != expected {
			return &Error{Status: 409, Code: "revision-conflict", Message: "Wiki 页面版本已变化，请重新读取"}
		}
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if expected == 0 {
		_, err = tx.ExecContext(ctx, "INSERT INTO wiki_pages(id,space_id,slug,current_revision,status,document) VALUES(?,?,?,?,?,?)", p.ID, p.SpaceID, p.Slug, p.Revision, p.Status, string(raw))
	} else {
		_, err = tx.ExecContext(ctx, "UPDATE wiki_pages SET current_revision=?,status=?,document=? WHERE id=? AND current_revision=?", p.Revision, p.Status, string(raw), p.ID, expected)
	}
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO wiki_page_revisions(page_id,revision,digest,document) VALUES(?,?,?,?)", p.ID, p.Revision, p.Digest, string(raw)); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM wiki_fts WHERE page_id=?", p.ID); err != nil {
		return err
	}
	if p.Status == "active" {
		if _, err = tx.ExecContext(ctx, "INSERT INTO wiki_fts(page_id,space_id,title,body) VALUES(?,?,?,?)", p.ID, p.SpaceID, p.Title, state.WikiFTSText(*p)); err != nil {
			return err
		}
	}
	if p.Status == "withdrawn" {
		_, err := tx.ExecContext(ctx, "INSERT INTO wiki_artifacts(kind,id,invalidated) VALUES('page',?,1)", state.WikiRefKey(WikiRef{PageID: p.ID, Revision: p.Revision, Digest: p.Digest}))
		return err
	}
	return saveWikiArtifact(ctx, tx, "page", state.WikiRefKey(WikiRef{PageID: p.ID, Revision: p.Revision, Digest: p.Digest}), "", "", 0, p.Sources)
}

// validateWikiRun is called at model/approval/dispatch/finish boundaries. Any
// invalidated source freezes the run before a new side effect can start.
func validateWikiRun(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, runID string) error {
	var generation, invalidated int
	err := q.QueryRowContext(ctx, "SELECT generation,invalidated FROM wiki_artifacts WHERE kind='run' AND id=?", runID).Scan(&generation, &invalidated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if invalidated != 0 {
		return &Error{Status: 409, Code: "wiki-context-invalidated", Message: "运行引用的 Wiki 页面已撤回，请重新开始任务"}
	}
	return nil
}

// 人工覆盖单个文件不代表其他文件的来源失效已解除。只有空版本不再承载原事实。
func carryWorkspaceWiki(ctx context.Context, tx *sql.Tx, version workspace.Version) error {
	if version.FileCount == 0 {
		return nil
	}
	base := version.TaskID + ":" + strconv.Itoa(version.BaseRevision)
	key := state.WorkspaceWikiKey(version)
	_, err := tx.ExecContext(ctx, `INSERT INTO wiki_artifacts(kind,id,task_id,generation,invalidated) SELECT 'workspace',?,task_id,generation,invalidated FROM wiki_artifacts WHERE kind='workspace' AND id=? ON CONFLICT DO NOTHING`, key, base)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO wiki_dependencies(kind,id,page_id,revision,digest) SELECT 'workspace',?,page_id,revision,digest FROM wiki_dependencies WHERE kind='workspace' AND id=? ON CONFLICT DO NOTHING`, key, base)
	return err
}

// embeddingSchema is deliberately SQLite-only. Vectors are JSON arrays so the
// page revision and its digest remain the authoritative index key; an optional
// native vector extension can be added without changing the Wiki contract.
const embeddingSchema = `
CREATE TABLE IF NOT EXISTS wiki_embedding_profiles(id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,
 PRIMARY KEY(id,revision));
CREATE TABLE IF NOT EXISTS wiki_embedding_indexes(page_id TEXT NOT NULL,page_revision INTEGER NOT NULL,digest TEXT NOT NULL,
 profile_id TEXT NOT NULL,profile_revision INTEGER NOT NULL,vector TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(page_id,page_revision,profile_id,profile_revision));
CREATE INDEX IF NOT EXISTS wiki_embedding_page ON wiki_embedding_indexes(page_id,page_revision);
CREATE TABLE IF NOT EXISTS wiki_embedding_requests(id TEXT PRIMARY KEY,state TEXT NOT NULL,document TEXT NOT NULL);
`

func saveEmbeddingRequest(ctx context.Context, tx *sql.Tx, record EmbeddingRequest) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO wiki_embedding_requests(id,state,document) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document", record.ID, record.Status, string(raw))
	return err
}

type EmbeddingRequest = state.EmbeddingRequest
