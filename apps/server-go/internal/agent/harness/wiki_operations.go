package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"
	"time"
)

func wikiCapabilities() []Capability {
	return []Capability{
		{Name: "wiki_search", Source: "wiki", ReadOnly: true, Description: "检索本轮固定空间的 Wiki 页面，返回有证据的长期知识。", Parameters: json.RawMessage(`{"type":"object","required":["query"],"additionalProperties":false,"properties":{"query":{"type":"string","minLength":1,"maxLength":512}}}`)},
		{Name: "wiki_read", Source: "wiki", ReadOnly: true, Description: "按稳定页面 ID 读取本轮可见的 Wiki 页面修订。", Parameters: json.RawMessage(`{"type":"object","required":["pageId"],"additionalProperties":false,"properties":{"pageId":{"type":"string","maxLength":128}}}`)},
		{Name: "wiki_follow_links", Source: "wiki", ReadOnly: true, Description: "读取指定 Wiki 页面链接到的可见页面。", Parameters: json.RawMessage(`{"type":"object","required":["pageId"],"additionalProperties":false,"properties":{"pageId":{"type":"string","maxLength":128}}}`)},
	}
}

func (m *Manager) executeWikiOperation(ctx context.Context, r Run, o Operation) (CapabilityResult, error) {
	if r.WikiStrategy == wikiNavigationStrategy {
		return m.executeWikiNavigation(ctx, r, o)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var in struct {
		Query  string `json:"query"`
		PageID string `json:"pageId"`
	}
	if err := json.Unmarshal([]byte(o.ArgumentsJSON), &in); err != nil {
		return CapabilityResult{}, err
	}
	if err := m.validateWikiRun(ctx, m.store.db, r.ID); err != nil {
		return CapabilityResult{}, err
	}
	pages, err := readDocuments[WikiPage](ctx, m.store.db, `SELECT p.document FROM wiki_visible_pages v JOIN wiki_page_revisions p ON p.page_id=v.page_id AND p.revision=v.revision WHERE v.owner_kind='run' AND v.owner_id=? ORDER BY v.page_id`, r.ID)
	if err != nil {
		return CapabilityResult{}, err
	}
	links := map[string]bool{}
	if o.Capability.Name == "wiki_follow_links" {
		for _, p := range pages {
			if p.ID == in.PageID {
				for _, id := range p.Links {
					links[id] = true
				}
			}
		}
	}
	hits := []WikiSearchHit{}
	visible := []WikiPage{}
	for _, p := range pages {
		ref := WikiRef{p.ID, p.Revision, p.Digest}
		if validateWikiSources(ctx, m.store.db, append(append([]WikiRef{}, p.Sources...), ref)) != nil {
			continue
		}
		if o.Capability.Name == "wiki_search" && p.ExpiresAt != "" {
			at, e := time.Parse(time.RFC3339Nano, p.ExpiresAt)
			if e != nil || !m.deps.Now().Before(at) {
				continue
			}
		}
		visible = append(visible, p)
		score := 1.0
		switch o.Capability.Name {
		case "wiki_search":
			score = wikiTextScore(in.Query, wikiSearchText(p))
		case "wiki_read":
			if p.ID != in.PageID {
				continue
			}
		case "wiki_follow_links":
			if !links[p.ID] {
				continue
			}
		}
		if score > 0 {
			hits = append(hits, WikiSearchHit{Page: p, Score: score, Method: "fixed-revision-text"})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	search := WikiSearchResult{Items: hits}
	if o.Capability.Name == "wiki_search" {
		search = m.wikiHybridSearchLocked(ctx, visible, in.Query, search, 8)
		hits = search.Items
		if err := m.validateWikiRun(ctx, m.store.db, r.ID); err != nil {
			return CapabilityResult{}, err
		}
	}
	out := []WikiPage{}
	refs := []WikiRef{}
	used := 0
	for _, hit := range hits {
		p := hit.Page
		if len(out) >= 8 || used+len(p.Markdown)+len(p.Title) > wikiRecallBytes {
			continue
		}
		used += len(p.Markdown) + len(p.Title)
		out = append(out, p)
		refs = mergeWikiRefs(refs, p.Sources, []WikiRef{{p.ID, p.Revision, p.Digest}})
	}
	err = m.store.write(ctx, "wiki-operation-sources", func(tx *sql.Tx) error {
		g, e := wikiGeneration(ctx, tx, r.TaskID)
		if e != nil {
			return e
		}
		if e = saveWikiArtifact(ctx, tx, "run", r.ID, r.TaskID, r.ID, g, refs); e != nil {
			return e
		}
		return saveWikiArtifact(ctx, tx, "operation", o.ID, r.TaskID, r.ID, g, refs)
	})
	if err != nil {
		return CapabilityResult{}, err
	}
	var value any = out
	if o.Capability.Name == "wiki_search" {
		value = struct {
			Pages    []WikiPage `json:"pages"`
			Degraded bool       `json:"degraded"`
			Reason   string     `json:"reason,omitempty"`
		}{out, search.Degraded, search.Reason}
	}
	raw, err := json.Marshal(value)
	return CapabilityResult{Value: raw}, err
}
