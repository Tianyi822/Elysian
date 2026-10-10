package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
)

func (a *agentExecution) wikiRecallSourcesLocked(ctx context.Context, count int) ([]WikiRef, error) {
	if count == 0 {
		return nil, nil
	}
	var raw string
	if err := a.manager.store.db.QueryRowContext(ctx, "SELECT document FROM wiki_recalls WHERE run_id=?", a.run.ID).Scan(&raw); err != nil {
		return nil, err
	}
	var recall wikiRecall
	if err := json.Unmarshal([]byte(raw), &recall); err != nil {
		return nil, err
	}
	refs := []WikiRef{}
	for _, p := range recall.Pages {
		if count == 0 {
			break
		}
		if err := validateWikiSources(ctx, a.manager.store.db, []WikiRef{{p.ID, p.Revision, p.Digest}}); err != nil {
			var invalid *Error
			if errors.As(err, &invalid) && invalid.Code == "wiki-source-withdrawn" {
				continue
			}
			return nil, err
		}
		refs = mergeWikiRefs(refs, p.Sources, []WikiRef{{p.ID, p.Revision, p.Digest}})
		count--
	}
	return refs, nil
}

// 仅为本次真正进入请求的记忆、事实组和公开对话登记来源；被容量裁剪的召回页
// 不会让后续撤回错误地隔离这个 Run。已被模型使用的来源仍通过 Run/摘要传递。
func (a *agentExecution) modelWikiSourcesLocked(ctx context.Context, purpose string, evidence []EvidenceRef, revision int) ([]WikiRef, error) {
	q := a.manager.store.db
	refs, err := wikiArtifactRefs(ctx, q, "run", a.run.ID)
	if err != nil {
		return nil, err
	}
	memoryKey := a.run.TaskID + ":" + strconv.Itoa(revision)
	invalid, err := wikiArtifactInvalid(ctx, q, "memory", memoryKey)
	if err != nil {
		return nil, err
	}
	if !invalid {
		memory, e := wikiArtifactRefs(ctx, q, "memory", memoryKey)
		if e != nil {
			return nil, e
		}
		refs = mergeWikiRefs(refs, memory)
	}
	seen := map[string]bool{}
	for _, ev := range evidence {
		if seen[ev.RunID] {
			continue
		}
		seen[ev.RunID] = true
		invalid, e := wikiArtifactInvalid(ctx, q, "run", ev.RunID)
		if e != nil {
			return nil, e
		}
		if invalid {
			continue
		} // 中性执行凭据不带被隔离的内容。
		sources, e := wikiArtifactRefs(ctx, q, "run", ev.RunID)
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			return nil, e
		}
		refs = mergeWikiRefs(refs, sources)
	}
	if purpose == "inference" {
		refs = mergeWikiRefs(refs, a.inferenceWikiRefs)
	}
	return refs, nil
}

func recordWikiRunArtifact(ctx context.Context, tx *sql.Tx, r Run, kind, id string) error {
	refs, err := wikiArtifactRefs(ctx, tx, "run", r.ID)
	if err != nil {
		return err
	}
	generation, err := wikiGeneration(ctx, tx, r.TaskID)
	if err != nil {
		return err
	}
	if err = (&Manager{}).validateWikiRun(ctx, tx, r.ID); err != nil {
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
