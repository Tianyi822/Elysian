package harness

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/harness/state"
)

func (a *agentExecution) wikiRecallSourcesLocked(ctx context.Context, count int) ([]WikiRef, error) {
	if count == 0 {
		return nil, nil
	}
	var raw string
	if err := readView(ctx, a.manager.store).WikiRecallRecord(ctx, a.run.ID, &raw); err != nil {
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
		if err := validateWikiSources(ctx, a.manager.store, []WikiRef{{PageID: p.ID, Revision: p.Revision, Digest: p.Digest}}); err != nil {
			var invalid *Error
			if errors.As(err, &invalid) && invalid.Code == "wiki-source-withdrawn" {
				continue
			}
			return nil, err
		}
		refs = state.MergeWikiRefs(refs, p.Sources, []WikiRef{{PageID: p.ID, Revision: p.Revision, Digest: p.Digest}})
		count--
	}
	return refs, nil
}

// 仅为本次真正进入请求的记忆、事实组和公开对话登记来源；被容量裁剪的召回页
// 不会让后续撤回错误地隔离这个 Run。已被模型使用的来源仍通过 Run/摘要传递。
func (a *agentExecution) modelWikiSourcesLocked(ctx context.Context, purpose string, evidence []EvidenceRef, revision int) ([]WikiRef, error) {
	q := a.manager.store
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
		refs = state.MergeWikiRefs(refs, memory)
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
		if e != nil && !errors.Is(e, sessionstore.ErrNotFound) {
			return nil, e
		}
		refs = state.MergeWikiRefs(refs, sources)
	}
	if purpose == "inference" {
		refs = state.MergeWikiRefs(refs, a.inferenceWikiRefs)
	}
	return refs, nil
}
