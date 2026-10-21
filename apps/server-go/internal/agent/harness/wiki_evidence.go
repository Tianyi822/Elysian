package harness

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

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
		return []WikiRef{{p.ID, p.Revision, p.Digest}}, nil
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
	if err = decodeWiki(raw, &p); err != nil {
		return p, err
	}
	if p.Kind != "sources" || !strings.HasPrefix(e.ID, p.ID+":") || !strings.Contains(p.Markdown, e.Text) {
		return p, bad("wiki-evidence-mismatch", fmt.Sprintf("来源证据与修订 %d 不符", rev))
	}
	return p, nil
}
