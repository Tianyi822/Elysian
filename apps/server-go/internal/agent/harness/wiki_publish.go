package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

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
		e.Digest = wikiDigest(e.Kind, e.Text)
		if err := validateWikiEvidence(ctx, tx, e); err != nil {
			return err
		}
		if p.Status != "withdrawn" {
			refs, err := wikiEvidenceSources(ctx, tx, *e)
			if err != nil {
				return err
			}
			p.Sources = mergeWikiRefs(p.Sources, refs)
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
			return &Error{429, "wiki-page-limit", "有效 Wiki 页面已达到 10000 页上限"}
		}
		var exists int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM wiki_pages WHERE space_id=? AND slug=?", p.SpaceID, p.Slug).Scan(&exists); err != nil {
			return err
		}
		if exists != 0 {
			return &Error{409, "wiki-slug-conflict", "空间中已存在相同 slug 的页面"}
		}
	} else {
		var current int
		if err := tx.QueryRowContext(ctx, "SELECT current_revision FROM wiki_pages WHERE id=?", p.ID).Scan(&current); err != nil {
			return err
		}
		if current != expected {
			return &Error{409, "revision-conflict", "Wiki 页面版本已变化，请重新读取"}
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
		if _, err = tx.ExecContext(ctx, "INSERT INTO wiki_fts(page_id,space_id,title,body) VALUES(?,?,?,?)", p.ID, p.SpaceID, p.Title, wikiFTSText(*p)); err != nil {
			return err
		}
	}
	if p.Status == "withdrawn" {
		_, err := tx.ExecContext(ctx, "INSERT INTO wiki_artifacts(kind,id,invalidated) VALUES('page',?,1)", wikiRefKey(WikiRef{p.ID, p.Revision, p.Digest}))
		return err
	}
	return saveWikiArtifact(ctx, tx, "page", wikiRefKey(WikiRef{p.ID, p.Revision, p.Digest}), "", "", 0, p.Sources)
}

func (m *Manager) markWikiEvidence(ctx context.Context, p *WikiPage) error {
	for i := range p.Evidence {
		e := &p.Evidence[i]
		if e.Kind == "workflow" {
			var n int
			if err := m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_instances WHERE id=?", e.ID).Scan(&n); err != nil {
				return err
			}
			e.OriginalCleared = n == 0
			continue
		}
		if e.RunID == "" {
			continue
		}
		var n int
		if err := m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM wiki_cleared_sources WHERE run_id=?", e.RunID).Scan(&n); err != nil {
			return err
		}
		e.OriginalCleared = n > 0
	}
	return nil
}

func (m *Manager) WikiSessionSelection(ctx context.Context, id string) (WikiSpaceSelection, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return WikiSpaceSelection{}, closedError()
	}
	if _, err := readSession(ctx, m.store.db, id); err != nil {
		return WikiSpaceSelection{}, err
	}
	var raw string
	var out WikiSpaceSelection
	err := m.store.db.QueryRowContext(ctx, "SELECT document FROM wiki_session_spaces WHERE session_id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	err = json.Unmarshal([]byte(raw), &out)
	return out, err
}
